import hashlib, io, json, logging, os, subprocess, tempfile, time, zipfile
from pathlib import Path
from pprint import pprint

log = logging.getLogger(__name__)

# Helpers for installing and updating our Photoshop plugin.
#
# This is more of a pain than it should be.  There's a commandline installer tool, but
# if you install with it directly it installs for all users.  That requires elevation,
# doesn't integrate with Adobe CC so the user can't uninstall it himself, and doesn't
# automatically push the plugin to Photoshop so it needs to be restarted manually.  That's
# not very useful.
#
# If you isntall a plugin by opening the file association (this is the same as the /doubleClick
# argument to the commandline tool), the CC window appears and annoys the user with a bunch
# of prompts.  That isn't a good UX when installing a trusted plugin, and there's no /silent
# argument to tell it to be quiet.  It also causes the plugin panel inside Photoshop to get
# reset, which is really annoying.
#
# To work around this, we update the plugin directly if it's already installed, so the user
# only sees the installation dialog the first time.
#
# We can't easily reload the plugin (and if we could it would cause the panel problem too).
# To work around this, a version.txt file is added to the plugin containing a hash of its
# contents, and the plugin checks to see if it's changed when Photoshop gains focus and reloads
# itself.  This works fine as long as the plugin metadata doesn't change.  If we need to
# change something that requires a full install, we'll change the plugin version number.

installer_path = Path("C:/Program Files/Common Files/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.exe")

root = Path(__file__).parent.parent.parent.resolve()
ps_extension_path = root / 'photoshop'

devel = True

def _get_plugin_version():
    """
    Read the version from the plugin manifest.

    The version is only changed if we've made a change that requires a full install and
    reload, which shouldn't happen often.
    """
    manifest_path = ps_extension_path / 'manifest.json'
    with manifest_path.open() as f:
        manifest = json.loads(f.read())
    return manifest['version']

# This is where our CCX plugin will be installed, as long as it's local to the user.
photoshop_ccx_plugin_path = Path(os.environ['APPDATA']) / 'Adobe/UXP/Plugins/External'
installed_plugin_path = photoshop_ccx_plugin_path / f'sd-webui-editor-link_{_get_plugin_version()}'

def _installed_plugin_version():
    """
    Return the version of the installed plugin, or None if not found.
    """
    # Plugins are installed with directories named "plugin-name_version".  We could also
    # get this from PluginsInfo/v1/PS.json.
    prefix = 'sd-webui-editor-link_'
    for file in photoshop_ccx_plugin_path.glob('*'):
        if not file.name.startswith(prefix):
            continue
        version = file.name[len(prefix):]
        return version

# def get_photoshop_plugin_status():
#     """
#     Look up the current status of the Photoshop plugin.  Return (enabled, version), or
#     (False, None) if the plugin isn't installed.
# 
#     Note that the UnifiedPluginInstallerAgent tool is very slow, and just looking up
#     the plugin list takes 300ms or more, so this should be done asynchronously and only
#     if needed.
#     """
#     try:
#         result = subprocess.check_output([installer_path, '/list', 'all'])
#     except FileNotFoundError:
#         log.info('UXP installer not found')
#         return False, None
# 
#     # There's no proper interface for this like a JSON output mode, so we have to parse
#     # the text output:
#     #
#     # 1 extension installed for Photoshop 2023 64 (ver 24.3.0)
#     #  Status                        Extension Name                         Version
#     # =========  =======================================================  ==========
#     #  Enabled    sd-webui-editor-link                                         1.0.0
#     #
#     # These strings are hardcoded into the installer binary, so it doesn't seem like they're
#     # localized.
#     result = result.split(b'\r\n')
#     for line in result:
#         status = line[1:10].strip()
#         name = line[12:50].strip()
#         version = line[70:].strip()
#         if name != b'sd-webui-editor-link':
#             continue
# 
#         if status not in (b'Enabled', b'Disabled'):
#             log.info('Unexpected UXP installer response')
# 
#         enabled = status == b'Enabled'
#         return enabled, version.decode('utf-8')
#     return False, None

def _read_photoshop_plugin_files():
    """
    Return a dictionary containing all files in the plugin.
    """
    # Read all files that we'll include in the package.
    files = {}
    for file in ps_extension_path.glob('**/*'):
        if not file.is_file():
            continue

        with file.open('rb') as f:
            data = f.read()

        relative_path = file.relative_to(ps_extension_path)
        files[relative_path.as_posix()] = data

    # Add version.txt containing a hash of all other files in the plugin.
    hash = hashlib.sha256()
    for file in sorted(files.keys()):
        data = files[file]
        hash.update(data)

    files['version.txt'] = hash.hexdigest().encode('utf-8')
    
    return files

_current_version = None
def _get_current_plugin_version():
    """
    Return the version hash for the plugin that we want installed.
    """
    # when not in development this can only change if the WebUI plugin itself is updated
    # and we're restarted.  Cache the version so we don't have to read the plugin data
    # each time we need this.
    global _current_version
    if not devel and _current_version is not None:
        return _current_version
        
    files = _read_photoshop_plugin_files()
    _current_version = files['version.txt']
    return _current_version

def _package_photoshop_plugin():
    """
    Create a CCX for the Photoshop plugin, returning its data.

    This is similar to the "Package" option in the UXP tool, and just creates a
    ZIP of the plugin.  The UXP tool does some other things like normalizing the
    manifest, which we don't need to do.
    """
    files = _read_photoshop_plugin_files()

    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as output_file:
        for path, data in files.items():
            output_file.writestr(path, data)

    return output.getbuffer()

def get_plugin_status():
    """
    Return:

    not-installed: The plugin isn't installed and can be installed with install_photoshop_plugin
    reinstall-required: A different version of the plugin is installed and must be reinstalled with install_photoshop_plugin
    not-synced: The plugin is installed but out of date and can be updated with update_photoshop_plugin
    ok: The plugin is ready
    """
    
    if not installed_plugin_path.exists():
        # See if a different version is installed.
        if _installed_plugin_version() is not None:
            return 'reinstall-required'
        else:
            return 'not-installed'

    if not check_plugin_contents():
        return 'not-synced'
    
    return 'ok'

def check_plugin_contents():
    """
    Return true if the plugin is installed and the version matches ours.
    """
    if not installed_plugin_path.exists():
        return False

    # Get the current version hash.
    current_hash = _get_current_plugin_version()

    # Get the installed version hash.
    installed_version_txt = installed_plugin_path / 'version.txt'
    installed_hash = installed_version_txt.open('rb').read()

    # See if the installed plugin matches our version.
    return installed_hash == current_hash

def install_photoshop_plugin():
    """
    Package and install the Photoshop plugin.

    This will open the Adobe CC window which will prompt the user to install.  We
    only need to do this if the plugin isn't already installed or the version in
    the manifest has changed.  Changes within the same version are done with
    update_photoshop_plugin() which doesn't bother the user.
    """

    ccx = _package_photoshop_plugin()

    # Write the CCX to a file.
    temp_dir = Path(tempfile.gettempdir())
    ccx_path = temp_dir / 'editor-link.ccx'
    with ccx_path.open('wb') as output:
        output.write(ccx)

    # Use UnifiedPluginInstallerAgent to trigger the install.  This is the same thing
    # that happens if the user launches the CCX in File Explorer.
    try:
        result = subprocess.check_output([installer_path, '/doubleClick', str(ccx_path)])
    except FileNotFoundError:
        log.info('UXP installer not found')
        return False, None

def update_photoshop_plugin():
    """
    Update the Photoshop plugin in-place if it's already installed.

    The plugin will reload itself when version.txt changes.
    """
    if not installed_plugin_path.exists():
        log.debug('Plugin not already installed')
        return

    if check_plugin_contents():
        log.debug('Plugin is already up to date')
        return

    log.info('Updating Photoshop plugin')

    # Replace all files inside the plugin.
    #
    # If files are deleted, we don't delete them in the installed plugin.  That would require
    # doing a recursive delete, which is dangerous if something unexpected goes wrong.  A couple
    # tiny leftover files won't hurt anything, so play it safe and just leave them around.
    files = _read_photoshop_plugin_files()

    # Move version.txt to the end, so we'll always update everything else first.  This way, we'll
    # only update version.txt after we've successfully updated everything else.
    filenames = list(files.keys())
    filenames.remove('version.txt')
    filenames.append('version.txt')

    for path in filenames:
        data = files[path]
        installed_path = installed_plugin_path / path

        # Don't touch files that haven't changed.
        with installed_path.open('rb') as f:
            installed_data = f.read()
            if installed_data == data:
                continue

        log.debug(f'Update: {path}')
        with installed_path.open('w+b') as f:
            f.truncate()
            f.write(data)

def test():
    status = get_plugin_status()
    log.info(f'Status: {status}')

    if status == 'ok':
        log.info('Already installed')
    elif status in ('not-installed', 'reinstall-required'):
        install_photoshop_plugin()
    elif status == 'not-synced':
        update_photoshop_plugin()

test()
