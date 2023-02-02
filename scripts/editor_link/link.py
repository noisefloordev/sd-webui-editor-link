import asyncio, logging, os, tempfile
import gradio as gr
from gradio import blocks
from pathlib import Path
from PIL import Image
from fastapi import FastAPI, Body, WebSocket
from fastapi.responses import FileResponse
from modules import images as sd_images, scripts, script_callbacks
from modules.shared import cmd_opts
from modules.ui_gradio_extensions import webpath
from modules.paths import script_path
from starlette import websockets
import urllib.parse

from . import photoshop_plugin, utils

script_path = Path(script_path)
log = logging.getLogger(__name__)

class LinkScript(scripts.Script):
    """
    This is created by the webui at startup and receives messages from it.  This may
    be created more than once.  All of the real logic is in SDSync.
    """
    def __init__(self):
        # This extension isn't designed to be used on a publically-accessible server,
        # since it does things like give access to local files.  It should only be used
        # when the server is only accessible locally.
        if not self.available:
            log.warning('sd-webui-editor-link is disabled because the WebUI is accessible beyond localhost')
            return

        script_callbacks.on_app_started(self.startup)
    
    @property
    def available(self):
        publically_accessible = cmd_opts.share or cmd_opts.listen or cmd_opts.server_name
        return not publically_accessible

    def show(self, is_img2img):
        if not self.available:
            return False
        else:
            return scripts.AlwaysVisible

    def title(self):
        return 'sd-webui-editor-link'

    def postprocess(self, p, processed, *args):
        if not self.available:
            return

        self.plugin.rendered_images(p, processed)

    def startup(self, blocks: gr.Blocks, app: FastAPI):
        # Create the SDSync instance.  This will be the same object if LinkScript is created
        # more than once.
        self.plugin = SDSync.get(blocks, app)

def _get_actual_event_loop():
    """
    Return the current event loop, or None if one isn't running.
    """
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        # Why is there no real API for this?
        return None

def add_api(app, sdSync):
    @app.get("/editor-link/photoshop-plugin-status")
    async def photoshop_plugin_status():
        status = photoshop_plugin.get_plugin_status()
        return { 'status': status }

    @app.get("/editor-link/read-file")
    async def api_read_file(path: str):
        """
        Return the contents of a file.

        This gives open access to the local filesystem, so we currently only allow enabling this
        extension when it's only listening on localhost.
        """
        return FileResponse(path)

    @app.get("/editor-link/install-photoshop-plugin")
    async def api_read_file():
        """
        Launch the Adobe Creative Cloud installation window for the plugin.

        This is only done on request.
        """
        photoshop_plugin.install_photoshop_plugin()
        return { }

    @app.get("/editor-link/update-photoshop-plugin")
    async def api_read_file():
        """
        Update the Photoshop plugin in-place.

        This normally happens when we're loaded, since it's transparent and doesn't need to prompt
        the user, but can be run manually if needed.
        """
        photoshop_plugin.update_photoshop_plugin()
        return { }

class SDSync:
    singleton = None

    @classmethod
    def get(cls, blocks, app):
        """
        Return the SDSync singleton, creating it if it doesn't exist.

        blocks and app must be the same on each call.
        """
        if cls.singleton is None:
            cls.singleton = cls(blocks, app)
        else:
            # LinkScript may be created multiple times, but the startup arguments should
            # be the same.
            assert cls.singleton.blocks is blocks
            assert cls.singleton.app is app
        return cls.singleton

    def __init__(self, blocks, app):
        self.blocks = blocks
        self.app = app
        self.images_to_masks = {}
        self.local_url = blocks.local_url

        self.clients = set()

        app.websocket("/editor-link")(self.websocket_endpoint)
        add_api(app, self)

        # If the Photoshop plugin is already installed, see if it needs to be updated.
        photoshop_plugin.update_photoshop_plugin()

        self._create_ui(blocks)

    async def websocket_endpoint(self, websocket: WebSocket):
        log.debug('websocket connected')

        client = WebsocketClient(websocket)

        try:
            # Keep track of active clients.
            self.clients.add(client)

            await websocket.accept()

            while True:
                # Handle commands from this client.
                data = await websocket.receive_json()
                response = await self.handle_websocket_message(websocket, data)
                if response is not None:
                    await client.send_message(response)
        except websockets.WebSocketDisconnect as e:
            # Don't print an error on disconnection.
            pass
        finally:
            self.clients.remove(client)

    async def handle_websocket_message(self, websocket, data):
        action = data.get('action')

        # Relay all messages to all other connected clients.
        await self.broadcast_message(data)

        return None

    async def broadcast_message(self, message, source_client=None):
        """
        Send message to all clients.  An event loop must be running on this thread.

        If source_client is set, don't send the message to it.
        """
        tasks = []
        for client in self.clients:
            if client.websocket is source_client:
                continue

            tasks.append(client.send_message(message))

        await asyncio.gather(*tasks, return_exceptions=True)

    def broadcast_message_threaded(self, message):
        """
        Send message to all clients.  An event loop must not be running on this thread.
        """
        # The WebUI callbacks don't run in a thread that has an event loop.  There also
        # seems to be no way to ask FastAPI for its event loop: you can get it in a handler,
        # but not during setup.  This makes pushing a message into the queue a pain.
        assert _get_actual_event_loop() is None

        futures = []
        for client in self.clients:
            coro = client.send_message(message)
            future = asyncio.run_coroutine_threadsafe(coro, client.loop)
            futures.append(future)

        for future in futures:
            future.result()

    def _create_ui(self, blocks: gr.Blocks):
        # Make a dictionary of blocks by their elem_id so we can look them up easily.
        result = {}
        utils.get_blocks_by_id(blocks.children, result)

        def create_send_image_button(tab):
            send_button = gr.Button('✎ Send', visible=True)
            send_button.click(
                fn=lambda gallery, index: self.clicked_send_image(gallery, index, tab),
                _js="(gallery, idx) => [gallery, selected_gallery_index()]",
                inputs=[
                    result_gallery,
                    result_gallery, # index
                ],
                outputs=[],
                show_progress=False,
            )

        with blocks:
            # Add a button to the txt2img and img2img gallery button strips.
            for tab in ['txt2img', 'img2img']:
                result_gallery = result[f'{tab}_gallery']
                with result[f'image_buttons_{tab}']:
                    create_send_image_button(tab)

    def clicked_send_image(self, gallery, index, tab):
        # Get the path to the current image.
        if index == -1:
            index = 0

        if index >= len(gallery):
            log.info('No image to send')
            return

        image_path = gallery[index]['name']
        image_path = Path(image_path)

        # If we have a masked image for this entry, send it.  Otherwise, send the original
        # image.
        mask_image = self.images_to_masks.get(image_path)
        if mask_image:
            image_path = mask_image

        is_img2img = tab == 'img2img'

        # On txt2img, send to a new document.  On img2img, import a layer into the current document.
        self.send_image(image_path, new_document=not is_img2img)
        return []

    def send_image(self, image_path, *, new_document=True):
        log.info(f'Send image: {image_path}')

        path = webpath(str(image_path))
        url = urllib.parse.urljoin(self.local_url, path)

        self.broadcast_message_threaded({
            'action': 'load-image',
            'target': 'editor',
            'url': url,
            'localPath': path,
            'newDocument': new_document,
        })

    def rendered_images(self, p, processed):
        """
        A batch completed.  If this is on the img2img tab and we have an inpaint mask, save
        a copy of each result with the mask already applied, so we have it later if the user
        sends the image.  Store the path to each masked image in.images_to_masks
        
        This is the same as what save_mask_composite does, and this will cause some duplicate
        work if that's also enabled.
        """
        if len(processed.infotexts) == 0:
            return

        image_paths, images = self._get_actual_images(p, processed)
        self._save_composited_images(p, image_paths, images)

        # Let other clients know that some images were rendered.  If we have composited masks,
        # include their paths too.
        mask_paths = [self.images_to_masks.get(path) for path in image_paths]
        self.broadcast_message_threaded({
            'action': "rendered-images",
            'images': [str(path) for path in image_paths],
            'masked_images': [str(path) for path in mask_paths],
        })

    def _save_composited_images(self, p, image_paths, images):
        """
        After inpaint finishes, save a masked copy of each image.  Return an array of
        paths to the saved files.
        """
        # Stop if there's no mask.
        image_mask = getattr(p, 'mask_for_overlay', None)
        if not image_mask:
            return

        # Match the temp directory used by Gradio, so our temporary images go to the same place
        # as the rest.
        temp_dir = os.environ.get("GRADIO_TEMP_DIR") or str(Path(tempfile.gettempdir()) / "gradio")

        # Resize the mask to match the images.  We assume all images in one set are
        # the same size, so we only need to do this once.
        resized_image_mask = sd_images.resize_image(2, image_mask, images[0].width, images[0].height)

        for image_path, image in zip(image_paths, images):
            # Don't resolve() the path.  If the directory is inside a symlink outside of the
            # installation directory, we need to keep the original inner path or the URL to
            # access it won't work.
            # image_path = image_path.resolve()

            # Apply the mask to the output.  This is the same as what the save_mask/save_mask_composite
            # options do.
            image_mask_composite = Image.composite(
                image.convert('RGBA').convert('RGBa'),
                Image.new('RGBa', image.size),
                resized_image_mask.convert('L'))
            image_mask_composite = image_mask_composite.convert('RGBA')

            # Save the composited image for later.  We don't need to keep any metadata here.
            with tempfile.NamedTemporaryFile(delete=False, suffix=".png", dir=temp_dir) as file:
                image_mask_composite.save(file)
                path = Path(file.name)

            # Associate the file we saved with the path that will be in the gallery.  It seems
            # like the only way to do this is to use already_saved_as.  This only works if samples_save
            # is enabled, otherwise the image won't be saved until the gallery is set up, which hasn't
            # happened yet.
            self.images_to_masks[image_path] = path

    def _get_actual_images(self, p, processed):
        # If we have 6 images and 3 infotexts, there are two images per output.  This happens
        # when return_mask or return_mask_composite are enabled and we need to skip the extra
        # results.
        outputs_per_image = len(processed.images) // len(processed.infotexts)

        # Discard the grid, if any.
        generated_images = processed.images[processed.index_of_first_image:]

        image_paths = []
        images = []
        for idx, image in enumerate(generated_images):
            # We only care about the first output per image, so we ignore masks.
            if (idx % outputs_per_image) != 0:
                continue

            # The path this image has been saved to.  We'll map the result to this so we can find
            # it later.
            saved_path = getattr(image, 'already_saved_as', None)
            if not saved_path:
                log.info('Generated image wasn\'t saved, make sure samples_save is enabled')
                continue

            # already_saved_as is relative to script_path.  Resolve it to a filesystem path, since
            # that's what we'll get in the gallery info.
            saved_path = script_path / Path(saved_path)
            
            if not saved_path.exists():
                log.info(f'Generated image doesn\'t exist: {saved_path}')
                continue

            image_paths.append(saved_path)
            images.append(image)

        return image_paths, images

class WebsocketClient:
    def __init__(self, websocket):
        self.websocket = websocket
        self.loop = asyncio.get_running_loop()

    async def send_message(self, message):
        """
        Send a message to this client.

        This must be called from the same event loop as the WebSocket client.
        """
        assert _get_actual_event_loop() is self.loop
        return await self.websocket.send_json(message)
