# OCaml support for VS Code

This is an VS Code extension that provides OCaml language support.

> Status: pre-alpha.

## Features

* Basic syntax highlighting for *.ml, *.mli, *.mly and *.mll. _ported from textmate_
* Auto-completion (aka. IntelliSense). _powered by ocamlmerlin_
* Error check on the fly (aka. Lint). _powered by ocamlmerlin_
* Show type information on hover. _powered by ocamlmerlin_
* Peek and goto definition (also provide a symbol list). _powered by ocamlmerlin_
* Auto indent on your type. _powered by ocp-indent_ 

![features](images/ocaml-ide.png)

## Features planned

> Contributions are welcome.

* Code snippets.
* Debugger.
* Build system.
* Rename symbol (aka Refactor).
* Semantic highlighting.

## Requirements

```shell
opam install merlin
opam install ocp-indent
```

## Extension Settings

This extension contributes the following settings:

* `ocaml.ocpIndentPath`: path to opc-indent.
* `ocaml.merlinPath`: path to ocamlmerlin.
* `ocaml.lintDelay`: time to delay lint when make changes.

## Known Issues



## Release Notes

### 0.1.0

First published version.
