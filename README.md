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
* UTop integrated. _since v0.6.2_

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

## Tips

1). In VS Code, `*.ml` is associated to F# by default, You need manually config this in `settings.json` to make OCaml mode work with `*.ml` file.
```json
	"files.associations": {
		"*.ml": "ocaml",
		"*.mli": "ocaml"
	}
```
2). You need build with `-bin-annot` flag and set build folder in `.merlin` to get goto definitions works cross files.

3). Did you know vscode-ocaml works perfect with `.vscode/tasks.json`. Here is an example:

```Makefile
# Makefile
build:
	ocamlbuild -use-ocamlfind main.d.byte
clean:
	ocamlbuild -clean
.PHONY: build clean
```

```js
// .vscode/tasks.json
{
	"version": "0.1.0",
	"command": "make",
	"showOutput": "always",
	"tasks": [
		{
			"taskName": "clean"
		},
		{
			"taskName": "build",
			"problemMatcher": {
				"fileLocation": "relative",
				"owner": "ocaml",
				"pattern": [
					{
						"regexp": "^File \"(.*)\", line (\\d+), characters (\\d+)-(\\d+):$",
						"file": 1,
						"line": 2,
						"column": 3,
						"endColumn": 4
					},
					{
						"regexp": "^(?:(?:Parse\\s+)?(Warning|[Ee]rror)(?:\\s+\\d+)?:)?\\s+(.*)$",
						"severity": 1,
						"message": 2,
						"loop": true
					}
				]
			}
		}
	]
}
```

```js
// .vscode/launch.json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "OCaml",
            "type": "ocamldebug",
            "request": "launch",
            "program": "${workspaceRoot}/main.d.byte",
            "stopOnEntry": false,
            "preLaunchTask": "build" // Build before launch
        }
    ]
}
```

## Known Issues

See https://github.com/hackwaly/vscode-ocaml/issues?q=is%3Aopen+is%3Aissue+label%3Abug

## Release Notes

### 0.6.0

Support launch debug target in Integrated Terminal.
Add a command to switch between module implementation/signature.
Support Find references in file.
UTop integrated.
[More Info](https://github.com/hackwaly/vscode-ocaml/milestone/3?closed=1)

### 0.5.0

Support debug variable paging.
Support highlight occurrences and refactor in file.
[More Info](https://github.com/hackwaly/vscode-ocaml/milestone/1?closed=1)

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
