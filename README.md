## What this is for

Quickly send images back and forth between the SD WebUI and Photoshop.

- Generate an image and send it directly to Photoshop
- Paint an inpaint mask in Photoshop and send it to the inpaint tab
- Generate an inpaint and send it back to the Photoshop image as a layer

## Installation:

- Install the extension from the Extensions tab.  In "Install from URL", enter
https://github.com/noisefloordev/sd-webui-editor-link.git.
- Click "⚠️ Link" at the top of the WebUI to install the Photoshop extension.  (It'll be
updated automatically when possible, so this will only reappear if a reinstall is needed.)
- Open Photoshop's Plugins > Plugins Panel to load the plugin.

## How to use

Click the "Send" button below generated images to send to Photoshop.  txt2img will
open a new document, and img2img will add the image as a layer on the current document
if there is one.

In Photoshop, select a target from the dropdown and click "Send" to send to the WebUI.

Dropdown options:

- img2img: Load the image into img2img
- ControlNet: Load the image as a ControlNet reference image
- inpaint: Load the current layer as an inpaint mask.  Paint the mask black where you want to inpaint, and leave it transparent elsewhere.

Turning off "Link" at the top of the WebUI will turn it off for that tab, in case you
have multiple WebUI tabs and don't want them all receiving images.

## Notes

The extension will disable itself if the WebUI is listening on the network, because it
allows access to the local filesystem to allow loading files sent from Photoshop.
