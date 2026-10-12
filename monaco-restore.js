window.amdRequire = window.require;
window.require = window.__nodeRequire;
delete window.__nodeRequire;
