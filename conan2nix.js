#!/usr/bin/env node

// conan2nix
// convert conan requirements to nix expressions
// generate version pins of conan dependencies
// similar to cargo2nix, cabal2nix, etc.

// license: "public domain" or "CC0-1.0"
// author: milahu, date: 2021-04-24

// usage of output file conancache.nix in default.nix:
// conancache = callPackage ./conancache.nix {};

// https://docs.conan.io/en/latest/reference.html
// TODO set CONAN_USER_HOME=$TMP/conan -> conan will use cache in $TMP/conan/.conan/data
// TODO set CONAN_READ_ONLY_CACHE=true
// TODO disable all remotes -> work offline
// TODO patch conan build files to use cached includes?

// TODO use full conan-lock.json (base.lock does not have the full graph)
// $ conan info . --json=conan-graph.json
// contains ref, rev, pkg-id, pkg-rev

// TODO also cache:
// * conan_sources.tgz (done? right location in $out? is it needed anyway??)
// * sources from conandata.yml
// * patches from conandata.yml

// design goal: be space-efficient -> keep tgz files compressed: conan_export.tgz + conan_package.tgz
// -> conan cache must be writable -> overlayfs or per-file-symlinks or copy

// TODO avoid double downloads:
// download directly to nix store, verify md5 checksums, generate sha256 checksums

// out of scope: convert the logic in conanfile.py to nix
// -> handle optional dependencies
// -> parse python AST ... yay :/
// -> benefit: reduce local cache size (small gain, much pain)

// related:
// https://github.com/conan-io/conan/issues/4668 # Cache Downloads
// > If you do not want to download anything all the time then you could use conan's export_sources feature
// > https://docs.conan.io/en/latest/reference/conanfile/attributes.html#exports-sources
// https://github.com/conan-io/conan/pull/6287 # Feature/download cache
// > Implement a download cache, which can be shared and concurrently used among different conan user homes
// https://github.com/conan-io/conan/issues/6754 # [question] Offline - Extracting dependency tree with conan_api (without remotes)
// > You might want to have a look to the generated conan.lock lockfile when you do a conan install or similar. It has encoded the whole graph. There are other commands that will output a json with dependencies information too.
// > conan info poco/1.9.4@ --json=file.json
// > The file.json file will contain the dependencies. The conan info command will not use the internet if the packages are already in the cache.
// https://github.com/conan-io/conan/issues/6727 # [question] conan info|install skips cache and tries to find package from remote instead?
// > I've exported a package to my local cache successfully. I've disabled the default remote because I want to work locally.
// https://github.com/conan-io/conan/issues/5938 # [feature] using conan offline - normaly handle existent file in tools.download (uploader_downloader.py)
// https://github.com/conan-io/conan/issues/5575 # [Question] Offline usage without remote
// > in an offline environment I would suggest copying local cache from the one installed when online
// > recipes like OpenSSL are downloading the sources from the internet.
// > So even if you have the source code for the recipe,
// > you will not be able to create the package locally

/*

expected full:

tree ~/.conan/data/zlib/1.2.11/_/_/
~/.conan/data/zlib/1.2.11/_/_/
├── dl
│   ├── export
│   │   └── conan_export.tgz
│   └── pkg
│       └── 6af9cc7cb931c5ad942174fd7838eb655717c709
│           └── conan_package.tgz # https://conan.bintray.com/v2/conans/zlib/1.2.11/_/_/revisions/9e0c292b60ce77402bd9be60dd68266f/packages/6af9cc7cb931c5ad942174fd7838eb655717c709/revisions/5f36772c72e3fd2e17b9e093bfc4bbff/files/conan_package.tgz
├── export
│   ├── conandata.yml
│   ├── conanfile.py
│   └── conanmanifest.txt
├── locks
│   ├── 6af9cc7cb931c5ad942174fd7838eb655717c709 # = package id
│   └── 8b4490bc851e1c66c0a44d9243069c16449ee2db # = parent package id (parent in dependency tree)
├── metadata.json
├── metadata.json.lock
└── package
    └── 6af9cc7cb931c5ad942174fd7838eb655717c709
        ├── conaninfo.txt
        ├── conanmanifest.txt
        ├── include
        │   ├── zconf.h
        │   └── zlib.h
        ├── lib
        │   └── libz.a
        └── licenses
            └── LICENSE

cat ~/.conan/data/zlib/1.2.11/_/_/metadata.json | jq
{
  "recipe": {
    "revision": "9e0c292b60ce77402bd9be60dd68266f",
    "remote": "conan-center",
    "properties": {},
    "checksums": {
      "conan_export.tgz": {
        "md5": "a352f6da4e1f2080cb11dbb3930c95f0",
        "sha1": "2e882acc18c759dd6fee65d34055ae49088e3204"
      },
      "conanmanifest.txt": {
        "md5": "30ddd3caec66d9fe89fca9f42a6db478",
        "sha1": "0d478d95f8d24aa32faabe2b08636efc30df8dbb"
      },
      "conanfile.py": {
        "md5": "a193b53f617e5736be6814e767ccdae6",
        "sha1": "7e7e7e7afb485b432788b2df7879f8bf9c2fb8c2"
      }
    }
  },
  # TODO download (+ extract)
  "packages": {
    "6af9cc7cb931c5ad942174fd7838eb655717c709": { # packageId
      # ~/.conan/data/poco/1.9.4/_/_/package/8b4490bc851e1c66c0a44d9243069c16449ee2db/conaninfo.txt:50:    expat/2.2.10:6af9cc7cb931c5ad942174fd7838eb655717c709
      # ~/.conan/data/poco/1.9.4/_/_/package/8b4490bc851e1c66c0a44d9243069c16449ee2db/conaninfo.txt:51:    openssl/1.1.1i:6af9cc7cb931c5ad942174fd7838eb655717c709
      # ~/.conan/data/poco/1.9.4/_/_/package/8b4490bc851e1c66c0a44d9243069c16449ee2db/conaninfo.txt:54:    zlib/1.2.11:6af9cc7cb931c5ad942174fd7838eb655717c709
      "revision": "5f36772c72e3fd2e17b9e093bfc4bbff",
      "recipe_revision": "9e0c292b60ce77402bd9be60dd68266f", # TODO where does this come from? -> full graph
      "remote": "conan-center",
      "properties": {},
      "checksums": {
        # https://conan.bintray.com/v2/conans/zlib/1.2.11/_/_/revisions/9e0c292b60ce77402bd9be60dd68266f/packages/6af9cc7cb931c5ad942174fd7838eb655717c709/revisions/5f36772c72e3fd2e17b9e093bfc4bbff/files/
        "conaninfo.txt": {
          "md5": "91c86a058a3e85683887a5ca5ee30f12",
          "sha1": "4eea41c9dfb9fcce856ede2f4f4f5d38ea2c3e05"
        },
        "conan_package.tgz": { # https://conan.bintray.com/v2/conans/zlib/1.2.11/_/_/revisions/9e0c292b60ce77402bd9be60dd68266f/packages/6af9cc7cb931c5ad942174fd7838eb655717c709/revisions/5f36772c72e3fd2e17b9e093bfc4bbff/files/conan_package.tgz
          "md5": "4df5522f9ab03e6a209d612bf42e2d94",
          "sha1": "c5b40aea703b3e27cd3d1bc9f1917086503a2b2c"
        },
        "conanmanifest.txt": {
          "md5": "19b5c477bdce0fa6da3920be8216eeed",
          "sha1": "83a7344f1a026f0120bfd88ff54e3475f43a3d34"
        }
      }
    }
  }
}

curl -s https://conan.bintray.com/v2/conans/zlib/1.2.11/_/_/revisions/9e0c292b60ce77402bd9be60dd68266f/packages/6af9cc7cb931c5ad942174fd7838eb655717c709/revisions/5f36772c72e3fd2e17b9e093bfc4bbff/files | jq
{
  "files": {
    "conaninfo.txt": {},
    "conan_package.tgz": {},
    "conanmanifest.txt": {}
  }
}




expected:

tree ~/.conan/data/abseil/20200923.3/_/_/
~/.conan/data/abseil/20200923.3/_/_/
├── dl
│   └── export
│       └── conan_export.tgz
├── export
│   ├── conandata.yml
│   ├── conanfile.py
│   └── conanmanifest.txt
├── metadata.json
└── metadata.json.lock



actual:

nix-build -E 'with import <nixpkgs> { }; let cc = callPackage ./conancache.nix { }; in cc."abseil/20200923.3#b2d602ea9f45c5bb738956d0f7aafa3d"'
tree
/nix/store/rfg41xrci9jfs0inm5vs5h4ra06dvnwa-abseil-20200923.3-b2d602ea9f45c5bb738956d0f7aafa3d/abseil/20200923.3/_/_/
├── dl
│   └── export
│       └── conan_export.tgz
├── export
│   ├── conandata.yml
│   ├── conanfile.py
│   └── conanmanifest.txt
└── metadata.json

*/

const sha256sum = s => require("crypto").createHash("sha256").update(s).digest("hex");
const sha1sum = s => require("crypto").createHash("sha1").update(s).digest("hex");
const md5sum = s => require("crypto").createHash("md5").update(s).digest("hex");

// arguments
const rev = '044219d37c9063e2181280b6bcaacf80260acd58'
const baseUrl = `https://raw.githubusercontent.com/google/orbit/${rev}`
const lockfileUrl = `${baseUrl}/third_party/conan/lockfiles/base.lock`

// github: conan-io/examples
const buildId = sha1sum('' + Math.random());
const conanProjectDir = '/home/user/src/conan-io--examples/libraries/protobuf/serialization'
const conanBuildDir = `${conanProjectDir}/build.${buildId}`;
if (!fs.existsSync(conanProjectDir)) throw `not found: ${conanProjectDir}`;
fs.mkdirSync(conanBuildDir);
process.chdir(conanBuildDir);
require('child_process').execSync('conan install ..');
process.chdir(conanProjectDir);
require('child_process').execSync(`conan info . --json=build.${buildId}/conan-graph.json`);

const conanGraph = JSON.parse(fs.readFileSync(`build.${buildId}/conan-graph.json`, 'utf8'));

for (const node of conanGraph) {
  if (!node.is_ref) continue;
  
}

// write local files to ...
const conanLockFile = 'conan-lockfile.json';
const outputFile = 'conancache.nix';
const localFilesDir = 'temp/';

// parse remotes from orbit/third_party/conan/configs/linux/remotes.txt
const remotesText = `\
bintray https://api.bintray.com/conan/hebecker/orbitdeps True 
conan-center https://conan.bintray.com True 
bincrafters https://api.bintray.com/conan/bincrafters/public-conan True 
`;
const remoteEntries = remotesText.trim().split('\n').map(line => line.split(' ').slice(0, 2));
const remoteUrls = Object.fromEntries(remoteEntries); // lookup: name -> url
const remoteNames = Object.fromEntries(remoteEntries.map(([name, url]) => [url, name])); // reverse lookup: url -> name



// debug
const processAllDeps = false
const maxDone = 999999
const getActualChecksums = true // true: download all files for checksums

const fs = require('fs')
const fetch = require('node-fetch')

// https://flaviocopes.com/how-to-uppercase-first-letter-javascript/
const capitalize = (s) => {
  if (typeof s !== 'string') return ''
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}
const camelCase = s => s.split(/[._/-]/).map((part, idx) => (idx == 0) ? part : capitalize(part)).join('')

async function main() {

let conanLock;
if (fs.existsSync(conanLockFile)) {
  conanLock = JSON.parse(fs.readFileSync(conanLockFile, 'utf8'));
}
else {
  console.log(`lockfileUrl = ${lockfileUrl}`);
  const response = await fetch(lockfileUrl);
  const body = await response.text();
  fs.writeFileSync(conanLockFile, body, 'utf8')
  console.log('saved local file: '+conanLockFile)
  conanLock = JSON.parse(body);
}

//console.dir(conanLock.graph_lock.nodes);

/*
https://conan.bintray.com/v2/conans/boost/1.75.0/_/_/revisions/16052c9d9027c7a581c5ddd7e968fd81/packages/85e3a50ba657ee206605ff8a7593591f64dddff7/revisions/1650b88f1b0248cbd2dbed1a9f55311a/files/conaninfo.txt
https://conan.bintray.com/v2/conans/boost/1.75.0/_/_/revisions/16052c9d9027c7a581c5ddd7e968fd81/packages/85e3a50ba657ee206605ff8a7593591f64dddff7/revisions/1650b88f1b0248cbd2dbed1a9f55311a/files/conan_package.tgz
https://conan.bintray.com/v2/conans/boost/1.75.0/_/_/revisions/16052c9d9027c7a581c5ddd7e968fd81/packages/85e3a50ba657ee206605ff8a7593591f64dddff7/revisions/1650b88f1b0248cbd2dbed1a9f55311a/files/conanmanifest.txt

conan-graph.json: graph node:
  reference = boost/1.75.0
  revision = 16052c9d9027c7a581c5ddd7e968fd81
  id = 85e3a50ba657ee206605ff8a7593591f64dddff7
  package_revision = 1650b88f1b0248cbd2dbed1a9f55311a
  is_ref = true
  url = https://github.com/conan-io/conan-center-index
  homepage = https://www.boost.org
  license = [ BSL-1.0 ]
  description = "Boost provides free peer-reviewed portable C++ source libraries"

*/

const indent = '';
let nixString = '';
nixString += indent + '{ stdenv, fetchurl, writeText }: {\n'

let numDone = 0

// loop deps
// first node is root project (for example google-orbit)
for (const [nodeId, node] of Object.entries(conanLock.graph_lock.nodes).slice(1)) {
  const pkgReference = node.ref;

  let [, pname, version, user, channel, pkgRevision] = pkgReference.match(/^([^/]+)\/([^@#]+)(?:@([^/]+)\/([^#]+))?#(.*)$/);
  if (!user) user = '_';
  if (!channel) channel = '_';
  console.dir({ pkgReference, pname, version, user, channel, pkgRevision });

  const pkgClean = `${pname}-${version}`.replace(/\//g, '_')
  const filebase = `${pname}-${version}-${user}-${channel}-${pkgRevision}`.replace(/\//g, '_')

  const remoteFilesDir = `/v2/conans/${pname}/${version}/${user}/${channel}/revisions/${pkgRevision}/files`;

  // TODO better?
  // when use what remote? bintray vs conan-center vs bincrafters
  // https://github.com/conan-io/conan/blob/develop/conans/client/rest/rest_client_v2.py
  // here we simply guess the remote
  let remoteName = null;
  let remoteUrl = null;
  let remoteFound = false;
  let remoteFileList = null;
  for (let remoteId = 0; remoteId < remoteEntries.length; remoteId++) {
    [remoteName, remoteUrl] = remoteEntries[remoteId];
    const url = `${remoteUrl}${remoteFilesDir}`
    console.log(`url = ${url}`);
    const response = await fetch(url);
    //console.dir({ url, response })
    if (response.status != 200) continue;
    const data = await response.json();
    remoteFileList = Object.keys(data.files); // TODO recursive?
    if (Object.values(data.files).find(obj => Object.keys(obj).length > 0)) {
      nixString += `/*\nerror: not implemented: nested remote files -> missing files\ndirectory listing = ${JSON.stringify(data, null, 2)}\n*/\n`;
    }
    remoteFound = true;
    break
  }
  if (remoteFound == false) {
    nixString += `${indent}# error: not found ${pkgReference} = ${pname}/${version}/${user}/${channel} on any remote\n`;
    continue // next package
  }

  const fileList = [];
  for (const filePath of remoteFileList) {
    //if (filePath == 'conan_sources.tgz') continue; // skip file. conan_sources.tgz is never stored in ~/.conan/data. but where is conan_sources.tgz used?
    const url = `${remoteUrl}${remoteFilesDir}/${filePath}`
    console.log(`url = ${url}`);
    const response = await fetch(url);
    const contentType = response.headers.get('content-type'); // trust the server ... otherwise use https://github.com/sindresorhus/file-type
    const isBinary = !(contentType.split('/')[0] == 'text' || contentType.split('/')[1] == 'json');
    const content = isBinary ? await response.buffer() : await response.text();
    const localPath = localFilesDir + filePath;
    const fileDir = require('path').dirname(localPath);
    if (fileDir != '.') fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(localPath, content, isBinary ? undefined : 'utf8');
    console.log('saved local file: '+localPath)
    const nixName = camelCase(filePath); // TODO avoid collisions -> append -1 -2 -3 etc
    const sha256 = require("crypto").createHash("sha256").update(content).digest("hex");
    // needed for metadata.json:
    const sha1 = require("crypto").createHash("sha1").update(content).digest("hex");
    const md5 = require("crypto").createHash("md5").update(content).digest("hex");
    const file = { path: filePath, nixName, url, md5, sha1, sha256, content, isBinary };
    //console.dir(file);
    fileList.push(file);
  }

  //console.dir(fileList);
  const remoteFilesUrl = `${remoteUrl}${remoteFilesDir}`;

  // verify md5 checksums in conanmanifest.txt
  // skip line 1: looks like a file size in bytes
  const conanmanifestTxt = fileList.find(f => f.path == 'conanmanifest.txt');
  if (!conanmanifestTxt) console.log(`ERROR: no conanmanifest.txt in ${remoteFilesUrl}`);
  else {
    for (const fileLine of conanmanifestTxt.content.trim().split('\n').slice(1)) {
      const [, filePath, md5] = fileLine.match(/^(.*): (.*)$/);
      const localFile = fileList.find(f => f.path == filePath);
      if (!localFile) { verifyResult = 'skip'; } // conandata.yml is in conan_export.tgz, other files are in export_source.tgz
      else {
        if (md5 == localFile.md5) verifyResult = 'pass';
        else {
          verifyResult = 'fail';
          console.log(`\
ERROR: mismatch in md5 checksum of ${filePath}
  expected ${md5}
  actual   ${localFile.md5}
`);
        }
      }
      //console.log(`verify md5 checksum of ${filePath}: ${verifyResult}`)
    }
  }

  // TODO escape strings with JSON.stringify?
  nixString += `
  "${pkgReference}" =
  let
    # values for metadata.json
    metadata = {
      recipe = {
        revision = "${pkgRevision}";
        remote = "${remoteName}";
        properties = {};
        checksums = {
${fileList.map(file => {
          return `\
          "${file.path}" = {
            md5 = "${file.md5}";
            sha1 = "${file.sha1}";
          };`;
}).join('\n')}
        };
      };
      packages = {
        # TODO download packages to $path/packages/$packageId
        /*
        # ~/.conan/data/poco/1.9.4/_/_/package/8b4490bc851e1c66c0a44d9243069c16449ee2db/include/Poco/Poco.h
        "8b4490bc851e1c66c0a44d9243069c16449ee2db" = {
          "revision": "0cc5de4c69b7c1455406523fd7432445",
          "recipe_revision": "65c999ac1a3d9bdc01790f504e6cb7b4",
          "remote": "conan-center",
          "properties": {},
          "checksums": {
            # ~/.conan/data/poco/1.9.4/_/_/package/8b4490bc851e1c66c0a44d9243069c16449ee2db/conaninfo.txt
            "conaninfo.txt": {
              "md5": "048ad0025200438ee74a7698c3bb0caa",
              "sha1": "05ea169e3c68abb155ea1648de91d0e506c87996"
            },
            # contents of ~/.conan/data/poco/1.9.4/_/_/package/8b4490bc851e1c66c0a44d9243069c16449ee2db/ ?
            "conan_package.tgz": {
              "md5": "117ed725c142941a7f1f78633393cebf",
              "sha1": "ef9dd8aabb08e797a4ea15e89ac092c63c0d0c47"
            },
            # ~/.conan/data/poco/1.9.4/_/_/package/8b4490bc851e1c66c0a44d9243069c16449ee2db/conanmanifest.txt
            "conanmanifest.txt": {
              "md5": "41037feae660368fef1d7dfecefde378",
              "sha1": "8fda6464231b4a4e06e864140b4d196ab6f4a586"
            }
          }
        }


        */
      }
  
      };
    };
  in
  stdenv.mkDerivation rec {
    pname = "${pname}";
    version = "${version}-${pkgRevision}";
    remoteFilesUrl = ${JSON.stringify(remoteFilesUrl)};
${fileList.map(file => {

return `\
    ${file.nixName} = fetchurl {
      url = "$\{remoteFilesUrl}/${file.path}";
      ##name = "${file.path}"; # TODO can we remove name?
      sha256 = "${file.sha256}";
    };
`;
}).join('')}\
    metadataJson = writeText "metadata.json" (builtins.toJSON metadata);
    srcs = [${fileList.map(file => file.nixName).join(' ')} metadataJson];
    unpackPhase = "true"; # dont unpack (return true)
    # path is relative to \$CONAN_USER_HOME/.conan/data
    installPhase = ''
      path=${pname}/${version}/${user}/${channel}

      mkdir -p \$out/\$path/dl/export
      ${fileList.filter(file => file.path.endsWith('.tgz')).map(file => {
        return `cp \${${file.nixName}} \$out/\$path/dl/export/${file.path}`; // TODO mkdir recursive
      }).join('\n      ')}

      mkdir -p \$out/\$path/export
      ${fileList.filter(file => !file.path.endsWith('.tgz')).map(file => {
        return `cp \${${file.nixName}} \$out/\$path/export/${file.path}`; // TODO mkdir recursive
      }).join('\n      ')}

      # extract conandata.yml
      ${fileList.filter(file => file.path == 'conan_export.tgz').map(file => {
        return `tar xvf \${${file.nixName}} -C \$out/\$path/export/`;
      }).join('\n      ')}

      cp \${metadataJson} \$out/\$path/metadata.json
    '';
    #license = "TODO";
    #homepage = "TODO";
  };

`.replace(/^/, indent);

  // debug
  numDone++;
  if (!processAllDeps || numDone == maxDone) break;

}

nixString += indent+'}\n'

//console.log(nixString);
fs.writeFileSync(outputFile, nixString, 'utf8');
console.log(`done: ${outputFile}`);

}

main();
