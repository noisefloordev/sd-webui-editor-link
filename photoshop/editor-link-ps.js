const { app, constants, core } = require("photoshop");
const { entrypoints, storage } = require('uxp');
const fs = require('fs');
const psAction = require("photoshop").action;

const DefaultPort = 7860;
function getLocalPort()
{
    return localStorage["port"] ?? DefaultPort;
}

function setLocalPort(port)
{
    if(port == getLocalPort())
        return;

    if(port == DefaultPort)
        delete localStorage["port"];
    else
        localStorage["port"] = port;

    window.dispatchEvent(new Event("server-port-changed"));
}

async function showSettingsDialog()
{
    let dialog = document.createElement("dialog");
    document.body.appendChild(dialog);

    dialog.innerHTML = `
        <sp-label slot="label">Settings</sp-label>

        <form method=dialog>
        <sp-body>
            <sp-textfield type="number" placeholder="Port number" class=port>
                <sp-label slot="label">WebUI port:</sp-label>
            </sp-textfield>
        </sp-body>

        <footer>
            <button class=cancel uxp-variant="primary">Cancel</button>
            <button class=save type="submit" uxp-variant="cta">Save</button>
        </footer>
    `;

    dialog.querySelector(".save").addEventListener("click", () => dialog.close(""));
    dialog.querySelector(".cancel").addEventListener("click", () => dialog.close("reasonCanceled" /* sic */));
    let portNode = dialog.querySelector(".port");
    portNode.value = getLocalPort().toString();

    try {
        let save = await dialog.showModal();
        if(save == "reasonCanceled")
            return;

        let newPort = portNode.value;
        let port = parseInt(newPort);
        if(portNode == "" || isNaN(port))
            port = DefaultPort;
        setLocalPort(port);
    } finally {
        dialog.remove();
    }
}

class EditorLinkWebSocket extends EventTarget
{
    constructor()
    {
        super();

        let url = new URL("/editor-link", document.location);
        url.protocol = document.location.protocol == "https:"? "wss":"ws";
        this._url = url;

        window.addEventListener("focus", () => {
            if(this.connectionWanted && !this.connected)
                this.connect();
        });

        entrypoints.setup({
            panels: {
                vanilla: {
                    menuItems: [
                        { id: "settings", label: "Settings" },
                    ],
                    show: () => { },
                    invokeMenu: (id) => {
                        switch(id)
                        {
                        case "settings":
                            showSettingsDialog().catch(error);
                            break;
                        }
                    },
                },
            },
        });
    }

    get url() { return this._url; }
    set url(url)
    {
        url = new URL(url.toString());
        if(url == this._url)
            return;

        this._url = url;

        // Reconnect if we were connected or attempting to connect.
        if(this.connectionWanted)
        {
            this.disconnect();
            this.connect();
        }
    }

    get connected() { return this.webSocket != null && this.webSocket.readyState == 1; }
    get connectionWanted() { return this.connected || this.reconnectionTimer != null; }

    connect()
    {
        if(this.webSocket)
            return;

        this.webSocket = new WebSocket(this._url.toString());
        this.webSocket.onopen = (e) => this.onWebSocketOpened(e);
        this.webSocket.onclose = (e) => this.onWebSocketClosed(e);
        this.webSocket.onmessage = (e) => this.onWebSocketMessage(e);
    }

    disconnect()
    {
        this.cancelReconnection();

        if(this.webSocket == null)
            return;

        try {
            this.webSocket.close();
        } catch(e) {
            // Ignore close() throwing an error if it's already closed.
        }
        this.webSocket = null;
    }

    scheduleConnection()
    {
        if(this.webSocket != null || this.reconnectionTimer != null)
            return;

        this.reconnectionTimer = setTimeout(() => {
            this.reconnectionTimer = null;
            this.connect();
        }, 5000);
    }

    cancelReconnection()
    {
        if(this.reconnectionTimer != null)
        {
            clearTimeout(this.reconnectionTimer);
            this.reconnectionTimer = null;
        }
    }

    onWebSocketOpened(e)
    {
        this.cancelReconnection();
        this.dispatchEvent(new Event("connectionchanged"));
    }

    onWebSocketClosed(e)
    {
        this.disconnect();
        this.scheduleConnection();
        this.dispatchEvent(new Event("connectionchanged"));
    }

    onWebSocketMessage(e)
    {
        let event = new Event("message");
        event.data = JSON.parse(e.data);
        this.dispatchEvent(event);
    }

    send(data)
    {
        if(!this.connected)
            return false;

        data = JSON.stringify(data, null, 4);
        this.webSocket.send(data);
        return true;
    }
}

async function invertLayer()
{
    let command = {"_obj":"invert"};
    await psAction.batchPlay([command], {});
}

async function saveDocumentToTemp(doc, filename)
{
    let folder = await storage.localFileSystem.getTemporaryFolder();
    let outputImage = await folder.createFile(filename, { overwrite: true });
    await doc.saveAs.png(outputImage, { method: constants.PNGMethod.QUICK, compression: 2 });
    return outputImage;
}


async function readUrlToFile(url)
{
    // If the URL points to 127.0.0.1 use localhost instead, since putting "127.0.0.1"
    // in the manifest doesn't work.
    url = url.replace("://127.0.0.1", "://localhost");

    // Fetch the file.
    let resp = await fetch(url);
    if(!resp.ok)
        throw new Error(`Error reading ${url}: ${resp.status} ${resp.statusText}`);

    // First, find any existing "import-123.png" files.  We can't use the same filename
    // as one that's already open, or it'll cause the open document to be replaced.
    let firstIdx = 1;
    for(let doc of app.documents)
    {
        let { title } = doc;
        let match = title.match(/import-(\d+)/);
        if(!match)
            continue;

        let idx = parseInt(match[1]);
        firstIdx = Math.max(firstIdx, idx+1);
    }
    let imgData = await resp.arrayBuffer();
    // Write the image to a file that we can access directly.
    let tempFolder = await storage.localFileSystem.getTemporaryFolder();
    let inputFile = await tempFolder.createFile(`import-${firstIdx}.png`, { overwrite: true });
    await inputFile.write(imgData, {
        format: storage.formats.binary,
    });

    return inputFile;

}

async function openFile(file)
{
    let token = await storage.localFileSystem.createSessionToken(file);

    let command = {
        "_obj": "open",
        "null": { "_kind":"local", "_path": token },
    };

    await psAction.batchPlay([command], {});
}        

// Read version.txt.  This is created when the UXP package is created.
async function getCurrentVersion()
{
    let request = null;
    try {
        request = await fetch("version.txt");
    } catch(e) {
        // If version.txt doesn't exist, we're running in the UXP development tool directly
        // from source.
        return "devel";
    }

    return await request.text();
}

// When Photoshop gains focus, check version.txt to see if the plugin has been updated and
// reload ourself if so.
async function installAutoReload()
{
    // Read our version.
    let initialVersion = await getCurrentVersion().catch(error);

    window.addEventListener("focus", async() => {
        // Read the current version.  This should only change if the package is updated.
        let currentVersion = await getCurrentVersion().catch(error);

        if(initialVersion != currentVersion)
            document.location.reload();
    });
}

// We have to work around a nasty UXP bug: exceptions from asyncs are completely
// swalloed and not logged at all.  This is crazy, you can't release a scripting
// system with no error handling.
function error(e)
{
    console.error(e);
}

class SDEditorLinkPhotoshop
{
    constructor()
    {
        this.init().catch(error);
    }
    
    async init()
    {
        installAutoReload().catch(error);

        // PS doesn't implement focus events.  Simulate them so EditorLinkWebSocket's reconnections
        // on focus work.
        psAction.addNotificationListener(['hostFocusChanged'], (e, { active }) => {
            window.dispatchEvent(new Event(active? "focus":"blur"));
        });

        let refreshWebSocketsUrl = () => {
            let port = getLocalPort();
            this.connection.url = `ws://localhost:${port}/editor-link`;
        };
        this.connection = new EditorLinkWebSocket();
        refreshWebSocketsUrl();
        this.connection.connect();

        // Upodate the URL if the user changes it in settings.
        window.addEventListener("server-port-changed", () => refreshWebSocketsUrl());

        this.connection.addEventListener("message", async(e) => {
            switch(e.data.action)
            {
            case "load-image":
                let { target, url, localPath, newDocument } = e.data;

                // If the target isn't the editor, this isn't for us.
                if(target != "editor")
                    return;

                this.executeAsModal(async() => {
                    await this.importFromUrl({ url, localPath, newDocument });
                }, { undoName: "Import inpaint" });

                break;
            }
        });

        this.exportTargetNode = document.querySelector(".export-target");
        this.sendImageNode = document.querySelector(".send-image");

        this.sendImageNode.addEventListener("click", () => {
            this.executeAsModal(() => this.exportClicked(), { });
        });

        this.refreshUI();
        this.connection.addEventListener("connectionchanged", () => this.refreshUI());
    }

    async exportClicked()
    {
        let target = this.exportTargetNode.options[this.exportTargetNode.selectedIndex].dataset.type;
        switch(target)
        {
        case "inpaint":
            await this.exportToInpaint();
            break;
        default:
            await this.exportToTarget(target);
            break;
        }   
    }

    refreshUI()
    {
        if(this.connection.connected)
            this.sendImageNode.removeAttribute("disabled");
        else
            this.sendImageNode.setAttribute("disabled", 1);
    }
    
    executeAsModal(func, {undoName, ...options})
    {
        if(app.activeDocument == null)
            undoName = null;

        return core.executeAsModal(async(executionContext) => {
            let suspensionId = null;

            try {
                // If we were given an undo name, handle coalescing undo.
                const { hostControl } = executionContext;
                if(undoName != null)
                {
                    suspensionId = await hostControl.suspendHistory({
                        documentID: app.activeDocument._id,
                        name: undoName,
                    });
                }

                let result = await func();

                // On success, commit the undo block.
                if(suspensionId != null)
                    await executionContext.hostControl.resumeHistory(suspensionId, true);

                return result;
            } catch(e) {
                // Revert changes on exception.
                if(suspensionId != null)
                    await executionContext.hostControl.resumeHistory(suspensionId, false);

                // Photoshop swallows errors inside executeAsModal.
                console.error(e);
                app.showAlert(e.stack);
                throw e;
            }
        }, options);
    }

    importFromUrl = async({ url, localPath, newDocument }) =>
    {
        let mainDoc = app.activeDocument;
    
        // If we don't have an active document, always create a new one.
        if(mainDoc == null)
            newDocument = true;

        let inputFile;
        let deleteAfter = false;
        let filename;
        if(localPath != null)
        {
            filename = localPath.replace(/\\/g, "/");
            inputFile = await storage.localFileSystem.getEntryWithUrl("file:" + localPath);
        }
        else
        {
            inputFile = await readUrlToFile(url);
            filename = (new URL(url)).pathname;
            deleteAfter = true;
        }

        // Remove the path component from the filename.
        filename = filename.replace(/.*\//, "");

        // Open the file as a document.  It would be cleaner and cause less UI flicker to
        // just import it directly into the document, but I haven't found a way to do that.
        // The only API seems to be placing (drop an image onto the document), which is
        // completely broken for scripting.
        let importDoc = await app.open(inputFile);

        // Only delete the file if it's a temp file.
        if(deleteAfter)
            await inputFile.delete();

        // If we want a new document, stop here.
        if(newDocument)
            return;
    
        // Import the layers (there should be only one) into the original document.
        await importDoc.duplicateLayers(importDoc.layers, mainDoc);
    
        // Discard the temporary document.
        await importDoc.closeWithoutSaving();

        // Rename the layer to the name of the document.  There's usually one one layer, since
        // we're typically importing a PNG.  Note that duplicateLayers returns the source layers
        // instead of the new layers, so we have to use the selection instead.
        let layerName = filename.replace(/\.[^.]*/, ""); // remove extension
        for(let layer of mainDoc.activeLayers)
            layer.name = layerName;
    }

    // Export the whole current document to inpaint.  The selected layer is used as the
    // inpaint mask.
    async exportToInpaint()
    {
        let mainDoc = app.activeDocument;
        if(mainDoc == null || mainDoc.activeLayers.length != 1)
        {
            app.showAlert("One layer must be selected");
            return;
        }

        // Hide the active layer, so we don't merge the inpaint mask with the image.
        let sourceMaskLayer = mainDoc.activeLayers[0];
        let wasVisible = sourceMaskLayer.visible;
        sourceMaskLayer.visible = false;

        // Save the unmasked layer.
        let outputImage = await saveDocumentToTemp(mainDoc, "image.png");

        // Restore the layer's visibility.
        sourceMaskLayer.visible = wasVisible;

        // Export the mask into a temporary doc.
        let tempDoc = await app.documents.add({
            name: "Exported mask",
            width: mainDoc.width, height: mainDoc.height,
            mode: constants.NewDocumentMode.RGB,
            fill: constants.DocumentFill.BLACK,
        });

        await mainDoc.duplicateLayers([sourceMaskLayer], tempDoc);
        let newLayer = tempDoc.layers[0]; // assumes the only existing layer is the background
        newLayer.name = "Mask";
        newLayer.visible = true;

        // The mask is painted black, but we need to export it as white.
        await invertLayer();

        // It's convenient to set opacity on the mask while drawing to make it easier
        // to see.  Reset it to opaque if this was done.
        newLayer.fillOpacity = 100;
        newLayer.opacity = 100;

        // Save the mask.
        let outputMask = await saveDocumentToTemp(tempDoc, "mask.png");
        await tempDoc.closeWithoutSaving();

        console.log("Exported images:");
        console.log(outputImage.nativePath);
        console.log(outputMask.nativePath);

        this.loadInpaintWithMask(outputImage, "inpaint_img");
        this.loadInpaintWithMask(outputMask, "inpaint_mask");
    }

    async exportToTarget(target)
    {
        let outputImage = await saveDocumentToTemp(app.activeDocument, "image.png");
        this.loadInpaintWithMask(outputImage, target);
    }

    loadInpaintWithMask(image, target)
    {
        console.log(`Load ${target}: ${image.nativePath})`);
        this.connection.send({
            action: "load-image",
            localPath: image.nativePath,
            target,
        });
    }   
}

new SDEditorLinkPhotoshop();
