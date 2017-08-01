export default (msg) => {
    if (process.env.DEBUG_VSCODE_OCAML) {
        console.log(msg);
    }
};
