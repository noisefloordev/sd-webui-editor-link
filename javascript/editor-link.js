// This is the SD web UI extension.

(() => {

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

// Return the selected main UI tab.
function getCurrentTab()
{
    return document.querySelector("#tabs > .tab-nav > button.selected").innerText;
}

// Find the button used to select the given main UI tab.
function findMainTabButton(label)
{
    for(let node of document.querySelectorAll("#tabs > .tab-nav > button"))
    {
        if(node.innerText == label)
            return node;
    }
    return null;
}

function selectImg2ImgTab()
{
    // Find the img2img tab button.
    let button = findMainTabButton("img2img");
    button.click();
}

// Open the ControlNet foldout and select the given unit.
function openControlNetFoldout(doc, currentTab, unit)
{
    // Find the controlnet UI block.
    let container = doc.querySelector(`#${currentTab}_controlnet`); // eg. txt2img_controlnet
    if(container == null)
    {
        console.log("Couldn't find controlnet foldout");
        return;
    }

    let controlnetFoldout = container.querySelector(`#controlnet > .label-wrap`);
    if(!controlnetFoldout.classList.contains("open"))
        controlnetFoldout.click();

    // Select the desired unit.
    let unitTabButtons = container.querySelectorAll(`#${currentTab}_controlnet_tabs > .tab-nav > button`);
    for(let button of unitTabButtons)
    {
        // There's no meaningful metadata on these buttons, so we have to check the label.
        let wantedText = `ControlNet Unit ${unit}`;
        if(button.innerText.trim() == wantedText)
        {
            console.log("found");
            button.click();
        }
    }
}

function waitForLoad()
{
    return new Promise((resolve) => {
        onUiLoaded(() => resolve());
    });
}

class EditorLink
{
    constructor()
    {
        this.init();
    }

    async init()
    {
        await waitForLoad();
        this.sdApp = gradioApp();

        this.createLinkButton();

        // We need to be enabled on a per-tab basis, since you usually only want one tab receiving
        // messages, so this is a sessionStorage setting and not a webui setting.
        this.enabled = !sessionStorage.editorLinkDisabled;

        this.connection = new EditorLinkWebSocket();
        this.connection.connect();

        this.connection.addEventListener("message", async(e) => {
            if(!this.enabled)
                return;

            switch(e.data.action)
            {
            case "load-image":
                let { url, localPath, target } = e.data;

                let targets = [
                    "inpaint", "inpaint_img", "inpaint_mask", "img2img",
                    "controlnet0", "controlnet1", "controlnet2", "controlnet3",
                ];

                // If target isn't in our list, this image isn't for us.
                if(targets.indexOf(target) == -1)
                    return;

                // One of localPath or url should always be available.  If they're both set, they
                // refer to the same file and we can use either.
                if(url == null)
                {
                    // Use read-file to read a local file when we don't have a URL.
                    console.assert(localPath != null);

                    let params = new URLSearchParams();
                    params.set("path", localPath);

                    url = `/editor-link/read-file?${params}`;
                }

                console.log(`Loading ${target} from ${url}`);

                let response = await fetch(url);
                let img = await response.blob();
                this.loadImage(img, {
                    target
                });
                break;
            }
        });
    }

    set enabled(value)
    {
        this._enabled = value;
        if(value)
        {
            delete sessionStorage.editorLinkDisabled;
            this.editorLinkButton.dataset.enabled = 1;
        }
        else
        {
            sessionStorage.editorLinkDisabled = 1;
            delete this.editorLinkButton.dataset.enabled;
        }

        this.refreshLinkButton();
    }
    get enabled() { return this._enabled; }

    createLinkButton()
    {
        // Add our toggle button to the quick settings bar.
        this.editorLinkButton = document.createElement("button");
        this.editorLinkButton.innerHTML = "Link";
        this.editorLinkButton.addEventListener("click", () => this.linkButtonClicked());

        let quickSettings = this.sdApp.querySelector("#quicksettings");
        this.editorLinkButton.classList.add("editor-link-enabled-toggle");
        quickSettings.appendChild(this.editorLinkButton);

        window.addEventListener("focus", () => this.refreshLinkButton());
        this.refreshLinkButton();
    }

    // Check if the Photoshop plugin needs to be installed, and update the Link button with
    // an alert if so.
    async refreshLinkButton()
    {
        // Get the status of the Photoshop plugin.
        let request = await fetch("/editor-link/photoshop-plugin-status");
        let { status } = await request.json();
        switch(status)
        {
        case "ok":
            this.editorLinkButton.innerHTML = "Link";
            this.editorLinkButton.title = `sd-webview-editor-link is ${this.enabled? "enabled":"disabled"}`;
            break;

        case "not-installed":
            this.editorLinkButton.innerHTML = "⚠️ Link";
            this.editorLinkButton.title = `Reinstall the Editor Link Photoshop plugin`;
            break;
        case "reinstall-required":
            this.editorLinkButton.innerHTML = "⚠️ Link";
            this.editorLinkButton.title = `Install the Editor Link Photoshop plugin`;
            break;

        case "not-synced":
            this.editorLinkButton.innerHTML = "⚠️ Link";
            this.editorLinkButton.title = `Update the Editor Link Photoshop plugin`;
            break;
        }
    }

    async linkButtonClicked()
    {
        let request = await fetch("/editor-link/photoshop-plugin-status");
        let { status } = await request.json();
        switch(status)
        {
        case "ok":
            this.enabled = !this.enabled;
            break;

        case "not-installed":
        case "reinstall-required":
        {
            // This opens a window and prompts the user, so confirm with the user first.
            let text = `
            Install the sd-webui-editor-link Photoshop plugin?

            This will launch the Adobe Creative Cloud application.
            `;
            if(!confirm(text))
                return;

            // Start the install.  If this succeeds it'll cause the browser window to
            // lose focus, so we'll refresh the button when we get focus back.
            console.log("Installing Photoshop plugin");
            fetch("/editor-link/install-photoshop-plugin");

            break;
        }
        case "not-synced":
        {
            // not-synced doesn't normally happen in regular use, since the Python plugin will
            // do it automatically, but it can happen in development.
            console.log("Updating Photoshop plugin");
            let request = await fetch("/editor-link/update-photoshop-plugin");
            await request.text();

            // This is finished when the API call returns, so refresh.
            await this.refreshLinkButton();
            break;
        }
        }
    }

    // Load an image blob.
    loadImage(img, { target="inpaint" }={})
    {
        // Hopefully txt2img or img2img:
        let currentTab = getCurrentTab();

        // If the target only makes sense on img2img and we're on txt2img, also switch to img2img.
        // This makes sure we're not populating somewhere that's not visible.
        let allowedTypesForTxt2Img = ["controlnet0", "controlnet1", "controlnet2", "controlnet3"];
        if(currentTab == "txt2img" && allowedTypesForTxt2Img.indexOf(target) == -1)
            currentTab = null;
            
        // If we're not on the txt2img or img2img tab, switch to img2img.
        if(currentTab != "txt2img" && currentTab != "img2img")
        {
            selectImg2ImgTab();
            currentTab = "img2img";
        }

        let targetSelectors = {
            "inpaint": "#img2maskimg", // inpaint tab
            "img2img": "#img2img_image", // img2img tab
            "inpaint_img": "#img_inpaint_base", // inpaint upload tab, image
            "inpaint_mask": "#img_inpaint_mask", // inpaint upload tab, mask
            "controlnet0": `#${currentTab}_controlnet_ControlNet-0_input_image`, // eg. txt2img_controlnet_ControlNet-0_input_image
            "controlnet1": `#${currentTab}_controlnet_ControlNet-1_input_image`,
            "controlnet2": `#${currentTab}_controlnet_ControlNet-2_input_image`,
            "controlnet3": `#${currentTab}_controlnet_ControlNet-3_input_image`,
        };

        let targetTab = {
            "img2img": 0,
            "inpaint": 2,
            "inpaint_img": 4, // inpaint upload
            "inpaint_mask": 4, // inpaint upload
        };

        let targetSelector = targetSelectors[target];
        if(targetSelector == null)
        {
            alert(`Unrecognized loadImageIntoInpaint target: ${target}`);
            return;
        }

        // switch_to_img2img_tab is in ui.js.  If we're on img2img, switch to the inner img2img tab.
        // The image widgets may not be initialized until we do this.
        if(currentTab == "img2img" && targetTab[target])
            switch_to_img2img_tab(targetTab[target]);

        // If the target is a ControlNet unit, open the controlnet foldout.  This makes sure that
        // the lazy-loaded UI has been loaded.
        if(target.startsWith("controlnet"))
        {
            // If target is "controlnet2", we want unit 2.
            let unit = target.substr(10);
            openControlNetFoldout(this.sdApp, currentTab, unit);
        }

        // Find the target image widget.
        let targetNode = this.sdApp.querySelector(targetSelector);
        if(targetNode == null)
        {
            alert(`Couldn't find target for ${target} (${targetSelector})`);
            return;
        }

        // We want to send a synthetic drop event to the image window.  #img2maskimg is the "inpaint"
        // tab, but it's tricky to find the drop container inside it, since they don't use semantic
        // class names.  Find it by looking for "data-testid=image", which is the parent of the
        // container, and then taking the first child.  (This part is brittle.)
        let dropNode = targetNode.querySelector("[data-testid='image']").firstElementChild;
        if(dropNode == null)
        {
            alert(`Couldn't find the image for ${target}`);
            return;
        }

        let dropEvent = new Event("drop");
        dropEvent.dataTransfer = {files: [img]};
        dropNode.dispatchEvent(dropEvent);
    }
}

window.editorLink = new EditorLink();

})();
