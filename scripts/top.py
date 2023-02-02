# This is the main entry point that the webui loads.  Import LinkScript so the
# webui sees it, and register an on_app_started callback.
import modules.script_callbacks as script_callbacks
from scripts.editor_link.link import LinkScript
# script_callbacks.on_app_started(LinkScript.startup)
