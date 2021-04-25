#!/usr/bin/env python3.8

"""
find ~/.conan/data/ -name conanfile.py -exec grep -H 'git clone' '{}' \;

./conanfile-analyze.py /home/user/.conan/data/libunwindstack/80a734f14/orbitdeps/stable/export/conanfile.py
# /home/user/.conan/data/libunwindstack/80a734f14/orbitdeps/stable/export/conanfile.py
found: class LibunwindstackConan (ConanFile)
fake conans.ConanFile.__init__ () {}

run conanfile.py source()
fake conans.ConanFile.run ('git clone https://android.googlesource.com/platform/system/core.git android-core',) {}
Traceback (most recent call last):
  File "./conanfile-analyze.py", line 201, in <module>
    conanfile_instance.source()
  File "/home/user/.conan/data/libunwindstack/80a734f14/orbitdeps/stable/export/conanfile.py", line 22, in source
    self.run("git clone https://android.googlesource.com/platform/system/core.git android-core")
  File "./conanfile-analyze.py", line 128, in fake_run
    git_repos[-1]['owner'] = git_repos[-1]['url'].split("/")[-2]
IndexError: list index out of range
"""

# dynamic analysis of conanfile.py to find all source URLs
# license CC0-1.0

# related
# https://wiki.python.org/moin/SandboxedPython

# todo
# generate a new version of the conanfile.py,
# where all the download-code lines are disabled (commented)
# -> conans.ConanFile.run ('git clone ...')
# -> conans.tools.get ('http://...')
# ...
# problem: this will change the checksum of conanfile.py
# -> use a custom conan.py? where download-code is not executed

# conanfile_path = ~/.conan/data/llvm_mc/9.0.1-3/orbitdeps/stable/export/conanfile.py
# class LLVMMC(common.LLVMModulePackage)
# ImportError: cannot import name 'python_requires' from 'conans' (/home/user/.local/lib/python3.8/site-packages/conans/__init__.py)
# conans.python_requires() is deprecated https://docs.conan.io/en/latest/extending/python_requires.html

# status: currently fails on most conanfile.py files
# ModuleNotFoundError: No module named 'llvmpackage'
# ModuleNotFoundError: No module named 'conanfile_base'
# ImportError: cannot import name 'python_requires' from 'conans' (/home/user/.local/lib/python3.8/site-packages/conans/__init__.py)
# AttributeError: 'NoneType' object has no attribute 'st_mode'
# ...

import sys, importlib.util, ast, shlex, re
import os, conans, conans.tools, shutil # used in some conanfile.py (incomplete!)

if len(sys.argv) == 1:
  print("usage: %s <path-to-conanfile.py>" % sys.argv[0])
  print("locate conanfiles:")
  print("find ~/.conan/data/ -name conanfile.py")
  sys.exit(1)
conanfile_path = sys.argv[1]
print("# %s" % conanfile_path)

# we must patch everything thats called in `def source` ...
# until we find some catch-all solution (sandbox?)

# most conanfile.py only use tools.get and os.rename
# maybe use the AST to find all function calls in source() -> patch all these functions
# problem: some function-callers expect a return value

# args is empty when conanfile.py calls
# tools.get(**self.conan_data["sources"][self.version])
# like in ~/.conan/data/libunwind/1.5.0/_/_/export/conanfile.py
get_files = list()
def fake_get(*args, **kwargs):
  print("fake conans.tools.get %s %s" % (repr(args), repr(kwargs)))
  if len(args) > 0:
    get_files.append(dict(url=args[0], **kwargs))
conans.tools.get = fake_get

# /home/user/.conan/data/Outcome/3dae433e/orbitdeps/stable/export/conanfile.py
def fake_download(*args, **kwargs):
  print("fake conans.tools.download %s %s" % (repr(args), repr(kwargs)))
  if len(args) > 0:
    get_files.append(dict(url=args[0], **kwargs))
conans.tools.download = fake_download

# /home/user/.conan/data/Outcome/3dae433e/orbitdeps/stable/export/conanfile.py
def fake_load(*args, **kwargs):
  print("fake conans.tools.load %s %s" % (repr(args), repr(kwargs)))
  return "" # content of file
conans.tools.load = fake_load

# /home/user/.conan/data/Outcome/3dae433e/orbitdeps/stable/export/conanfile.py
def fake_save(*args, **kwargs):
  print("fake conans.tools.save %s %s" % (repr(args), repr(kwargs)))
conans.tools.save = fake_save

def fake_patch(*args, **kwargs):
  print("fake conans.tools.patch %s %s" % (repr(args), repr(kwargs)))
conans.tools.patch = fake_patch

# /home/user/.conan/data/qt/5.15.1/orbitdeps/stable/export/conanfile.py
def fake_replace_in_file(*args, **kwargs):
  print("fake conans.tools.replace_in_file %s %s" % (repr(args), repr(kwargs)))
conans.tools.replace_in_file = fake_replace_in_file

# /home/user/.conan/data/libiberty/9.1.0/_/_/export/conanfile.py
def fake_rmdir(*args, **kwargs):
  print("fake conans.tools.rmdir %s %s" % (repr(args), repr(kwargs)))
conans.tools.rmdir = fake_rmdir

# /home/user/.conan/data/nodejs/13.6.0/orbitdeps/stable/export/conanfile.py
def fake_check_sha256(*args, **kwargs):
  print("fake conans.tools.check_sha256 %s %s" % (repr(args), repr(kwargs)))
conans.tools.check_sha256 = fake_check_sha256

# /home/user/.conan/data/nodejs/13.6.0/orbitdeps/stable/export/conanfile.py
def fake_unzip(*args, **kwargs):
  print("fake conans.tools.unzip %s %s" % (repr(args), repr(kwargs)))
conans.tools.unzip = fake_unzip

def fake_init(self, *args, **kwargs): # NOTE we need the `self` argument
  print("fake conans.ConanFile.__init__ %s %s" % (repr(args), repr(kwargs)))
  self.conan_data = dict(sources=dict(fakeVersion=dict()))
  #self.version = "fakeVersion"
conans.ConanFile.__init__ = fake_init

cmd_history = []
git_repos = list()
def fake_run(self, *args, **kwargs): # NOTE we need the `self` argument
  global repo_url, repo_cwd, repo_rev # change global vars
  print("fake conans.ConanFile.run %s %s" % (repr(args), repr(kwargs)))
  cmd = args[0]
  cmd_history.append(cmd)
  cmd_args = shlex.split(cmd)
  # must know the CLI schema for argparse
  #cmd_parsed = argparse.ArgumentParser()
  #cmd_parsed.parse_args(cmd_args)
  # full git cli in python: https://github.com/dulwich/dulwich/blob/master/dulwich/cli.py
  # todo: support multiple repos with different cwd (and folder renaming)
  cwd = kwargs['cwd'] if 'cwd' in kwargs else '.'
  if cmd_args[0] == "git":
    if cmd_args[1] == "clone":
      if not cwd in git_repos:
        git_repos.append(dict())
      repo_url = cmd_args[-1]
      git_repos[-1]['url'] = cmd_args[-1]
      git_repos[-1]['name'] = re.sub(r"\.git$", "", git_repos[-1]['url'].split("/")[-1])
      git_repos[-1]['dir'] = git_repos[-1]['name'] # could be renamed in conanfile -> os.rename(src, dst)
      git_repos[-1]['owner'] = git_repos[-1]['url'].split("/")[-2]
    if cmd_args[1] == "checkout":
      git_repos[-1]['rev'] = cmd_args[-1] # todo find repo with dir == cwd
conans.ConanFile.run = fake_run

def fake_rename(*args, **kwargs):
  print("fake os.rename %s %s" % (repr(args), repr(kwargs)))
os.rename = fake_rename

# /home/user/.conan/data/zlib/1.2.11/_/_/export/conanfile.py
def fake_chmod(*args, **kwargs):
  print("fake os.chmod %s %s" % (repr(args), repr(kwargs)))
os.chmod = fake_chmod

# /home/user/.conan/data/zlib/1.2.11/_/_/export/conanfile.py
def fake_stat(*args, **kwargs):
  print("fake os.stat %s %s" % (repr(args), repr(kwargs)))
os.stat = fake_stat

# /home/user/.conan/data/lzma_sdk/19.00/orbitdeps/stable/export/conanfile.py
def fake_mkdir(*args, **kwargs):
  print("fake os.mkdir %s %s" % (repr(args), repr(kwargs)))
os.mkdir = fake_mkdir

# /home/user/.conan/data/lzma_sdk/19.00/orbitdeps/stable/export/conanfile.py
def fake_chdir(*args, **kwargs):
  print("fake os.chdir %s %s" % (repr(args), repr(kwargs)))
os.chdir = fake_chdir

# /home/user/.conan/data/lzma_sdk/19.00/orbitdeps/stable/export/conanfile.py
def fake_remove(*args, **kwargs):
  print("fake os.remove %s %s" % (repr(args), repr(kwargs)))
os.remove = fake_remove




# /home/user/.conan/data/qt/5.15.1/orbitdeps/stable/export/conanfile.py
def fake_move(*args, **kwargs):
  print("fake shutil.move %s %s" % (repr(args), repr(kwargs)))
shutil.move = fake_move




# load conanfile.py
spec = importlib.util.spec_from_file_location("conanfile", conanfile_path)
conanfile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(conanfile)
#print("dir(conanfile) = %s" % repr(dir(conanfile)))

# get class name (different for every package)
code = open(conanfile_path, 'r').read()
tree = ast.parse(code)
class_name = None
for node in ast.walk(tree):
  if isinstance(node, ast.ClassDef):
    baseIdList = [b.id for b in node.bases if hasattr(b, "id")]
    if "ConanFile" not in baseIdList: # class must inherit from class ConanFile
      continue
    class_name = node.name
    print("found: class %s (%s)" % (node.name, ", ".join(baseIdList)))
    break
if class_name == None:
  print("error: not implemented: no `class SomeClass(ConanFile)` was found")
  sys.exit(1)
conanfile_init = getattr(conanfile, class_name)
conanfile_instance = conanfile_init()



# action!
print("\nrun conanfile.py source()")
conanfile_instance.source()
print("done conanfile.py source()\n")



# print results
if len(cmd_history) > 0:
  print("cmd_history:")
  for cmd in cmd_history:
    print("$ %s" % cmd)
  print()

print("git_repos = %s" % repr(git_repos))
print("get_files = %s" % repr(get_files))
