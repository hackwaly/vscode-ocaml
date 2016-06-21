# OCaml support for VS Code

This is an VS Code extension that provides OCaml language support.

> Contributions are welcome. [github repo](https://github.com/hackwaly/vscode-ocaml.git)

## Features

* Basic syntax highlighting for `*.ml`, `*.mli`, `*.mly` and `*.mll`. _ported from textmate_
* Auto-completion (aka. IntelliSense). _powered by ocamlmerlin_
* Error check on the fly (aka. Lint). _powered by ocamlmerlin_
* Show type information on hover. _powered by ocamlmerlin_
* Peek and goto definition (also provide a symbol list). _powered by ocamlmerlin_
* Auto indent on your type. _powered by ocp-indent_
* Debugger integrated. _powered by ocamldebug_

![features](http://i.giphy.com/26BRsQmMAHdg1LNRe.gif)

![debugger](http://i.giphy.com/l46Cx0HvCXnUrVOkU.gif)

## Requirements

```shell
opam install merlin
opam install ocp-indent
```

## Extension Settings

This extension contributes the following settings:

* `ocaml.ocpIndentPath`: path to ocp-indent.
* `ocaml.merlinPath`: path to ocamlmerlin.
* `ocaml.lintDelay`: time to delay lint when make changes.

## Known Issues

In VS Code, `*.ml` is associated to F# by default, You need manually config this to make OCaml mode work with *.ml file.

```
"files.associations": {
    "*.ml": "ocaml"
}
```

## Release Notes

### 0.4.0

Add Windows debug support.
Add remote debug support.

### 0.3.0

Add keywords completion.
Add Menhir syntax over OCamlyacc syntax.

### 0.2.0

Add debugger (ocamldebug) support.

### 0.1.0

First published version.
