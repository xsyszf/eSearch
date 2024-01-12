import root_init from "../root/root";
root_init();
let configPath = new URLSearchParams(location.search).get("config_path");
const Store = require("electron-store");
var store = new Store({
    cwd: configPath || "",
});
if (store.get("语言.语言") != "zh-HANS") {
    let href = `http://fanyi.baidu.com/transpage?query=https%3A%2F%2Fe-search.vercel.app%2Fhelp.html&from=zh&to=${
        store.get("语言.语言").split("-")[0]
    }&source=url&render=1`;

    (<HTMLAnchorElement>document.getElementById("language")).href = href;
    document.getElementById("language").innerText = "Translation";
}

const { shell } = require("electron") as typeof import("electron");
document.onclick = (e) => {
    let el = <HTMLElement>e.target;
    if (el.tagName == "A") {
        if (new URL((<HTMLAnchorElement>el).href).origin != location.origin) {
            e.preventDefault();
            shell.openExternal((<HTMLAnchorElement>el).href);
        }
    }
};
