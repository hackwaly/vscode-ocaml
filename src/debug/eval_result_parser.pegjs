{
function fixList(list) {
	return list || [];
}
function fixList1(head, tail) {
	return [head].concat(tail.map(function (item) {
    	return item[2];
    }));
}
}

msg = name:id ':' _ type:type '=' _ value:value { return {name: name, type: type.trim(), value: value}; }
id = $([A-Za-z_'][A-Za-z_'.0-9]*)
type = $([^=]+)
value = unit / paren / tuple
tuple = head:primary tail:(',' _ primary)* { var items = fixList1(head, tail); return items.length === 1 ? items[0] : {kind: 'tuple', items: items}; }
unit = '()' { return {kind: 'plain', value: '()'}; }
paren = '(' value:value ')' { return value; }
primary = string / char / con / record / array / list / plain
con = con:id _ args:value { return {kind: 'con', con:con, args: args}; }
record = '{' list:field_list? '}' { return {kind: 'record', items: fixList(list)} }
field = name:id _ '=' _ value:value { return {name: name, value: value}; }
field_list = head:field tail:(';' _ field)* { return fixList1(head, tail); }
array
  = '[||]' { return {kind: 'array', items: []}; }
  / '[|' list:value_list '|]' { return {kind: 'array', items: list}; }
list
  = '[]' { return {kind: 'array', items: []}; }
  / '[' list:value_list ']' { return {kind: 'list', items: list}; }
value_list = head:value tail:(';' _ value)* { return fixList1(head, tail); }
string = value:$('"' ([^\\"] / '\\' .)* '"') { return {kind: 'plain', value: value}; }
char = value:$('\'' ([^\\'] / '\\\'' / '\\' [^']+) '\'') { return {kind: 'plain', value: value}; }
plain = value:$([^{}[\](),;]+) { return {kind: 'plain', value:value}; }
_ = $([ \t\r\n]*) {}
