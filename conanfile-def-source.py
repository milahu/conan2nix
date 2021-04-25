#!/usr/bin/env python3.8

# print the 'def source' part of a conanfile.py
# license CC0-1.0

import ast, sys

if len(sys.argv) == 1:
  print("usage: %s <path-to-conanfile.py>" % sys.argv[0])
  sys.exit(1)

path = sys.argv[1]

print("# %s" % path)

code = open(path, 'r').read()
tree = ast.parse(code)

found_ConanFile = False

for node in ast.walk(tree):
  if isinstance(node, ast.ClassDef):
    baseIdList = [b.id for b in node.bases if hasattr(b, "id")]
    # class must inherit from class ConanFile
    if "ConanFile" not in baseIdList:
      continue
    print("class %s (%s):" % (node.name, ", ".join(baseIdList)))
    found_ConanFile = True
  if isinstance(node, ast.FunctionDef) and node.name == 'source':
    #print(node.name)
    print(ast.get_source_segment(code, node))
    """
    for child in node.body:
      print("child:")
      print(ast.get_source_segment(code, child))
    """

if found_ConanFile == False:
  print("error: not implemented: no `class SomeClass(ConanFile)` was found")
