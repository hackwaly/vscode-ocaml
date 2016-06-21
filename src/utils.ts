export let log = (msg) => {
    if (process.env.DEBUG_VSCODE_OCAML) {
        console.log(msg);
    }
};
