#!/usr/bin/env node

// conan2nix
// convert conan requirements to nix expressions
// similar to cargo2nix, cabal2nix, etc.

// license: "public domain" or "CC0-1.0"
// author: milahu, date: 2021-04-24

// TODO verify checksums:
// find temp/ -type f -exec sha256sum '{}' \;

// TODO get conandata.yml (not in conan_sources.tgz -> skip conan_sources.tgz)

/*

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

cat ~/.conan/data/abseil/20200923.3/_/_/export/conandata.yml 
sources:
  '20200923.3':
    sha256: ebe2ad1480d27383e4bf4211e2ca2ef312d5e6a09eba869fd2e8a5c5d553ded2
    url: https://github.com/abseil/abseil-cpp/archive/20200923.3.tar.gz

cat ~/.conan/data/abseil/20200923.3/_/_/metadata.json | jq
{
  "recipe": {
    "revision": "b2d602ea9f45c5bb738956d0f7aafa3d",
    "remote": "conan-center",
    "properties": {},
    "checksums": {
      "conan_export.tgz": {
        "md5": "8a0c57a283c2ab579e676b2bc2ee6565",
        "sha1": "51776f21a4bc3ed9177d8663e24907efe3583ea7"
      },
      "conanmanifest.txt": {
        "md5": "a4997bb29975190163371a3f81543159",
        "sha1": "debdb80c399f5f5d4a33b60bc2a80bddc982e42f"
      },
      "conanfile.py": {
        "md5": "74addcc109f4e606abf57d75590d4540",
        "sha1": "a7afe538be9b315a4db92a9d7ea22921584531b8"
      }
    }
  },
  "packages": {}
}



actual:

tree temp/
temp/
├── conan_export.tgz
├── conan_sources.tgz
├── conanfile.py
└── conanmanifest.txt

tar tf temp/conan_sources.tgz 
CMakeLists.txt
patches/cmake-install.patch

*/

// lockfile:
// orbit/third_party/conan/lockfiles/base.lock

// TODO when use what remote? bintray vs conan-center vs bincrafters
// -> rest_client_v2.py
// https://github.com/conan-io/conan/blob/develop/conans/client/rest/rest_client_v2.py

// https://docs.conan.io/en/latest/reference.html
// TODO set CONAN_USER_HOME=/build/home/conan -> conan will use cache in /build/home/conan/.conan/data
// TODO set CONAN_READ_ONLY_CACHE=true

// arguments
const rev = '044219d37c9063e2181280b6bcaacf80260acd58'
const baseUrl = `https://raw.githubusercontent.com/google/orbit/${rev}`
const lockfileUrl = `${baseUrl}/third_party/conan/lockfiles/base.lock`

// orbit/third_party/conan/configs/linux/remotes.txt
const remoteList = [
  'https://api.bintray.com/conan/hebecker/orbitdeps',
  'https://conan.bintray.com',
  'https://api.bintray.com/conan/bincrafters/public-conan',
];

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

const conanLockFile = 'conan-lockfile.json';
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

console.dir(conanLock.graph_lock.nodes);

let nixString = '';
nixString += '  conanpkgs = {\n'

let numDone = 0

// loop deps
// first node is root project (for example google-orbit)
for (const [nodeId, node] of Object.entries(conanLock.graph_lock.nodes).slice(1)) {
  const pkgId = node.ref;

  let [, pname, version, user, channel, rev] = pkgId.match(/^([^/]+)\/([^@#]+)(?:@([^/]+)\/([^#]+))?#(.*)$/);
  if (!user) user = '_';
  if (!channel) channel = '_';
  console.dir({ pkgId, pname, version, user, channel, rev });

  const pkgClean = `${pname}-${version}`.replace(/\//g, '_')
  const filebase = `${pname}-${version}-${user}-${channel}-${rev}`.replace(/\//g, '_')

  const remoteFilesDir = `/v2/conans/${pname}/${version}/${user}/${channel}/revisions/${rev}/files`;

  // TODO remove extra logic for conanmanifest
  // simply get all files from directory listing -> remoteFileList (also includes conanmanifest.txt)
  const fileList = [];
  let conanmanifest = null
  let remote = null;
  for (const remoteCur of remoteList) {
    const filePath = 'conanmanifest.txt';
    const url = `${remoteCur}${remoteFilesDir}/${filePath}`
    console.log(`url = ${url}`);
    const response = await fetch(url);
    console.dir({ url, response })
    if (response.status == 200) {
      remote = remoteCur;
      const text = await response.text();
      conanmanifest = text;
      fs.writeFileSync(filePath, conanmanifest, 'utf8'); // debug: verify checksums

      // debug: verify checksums
      const localPath = 'temp/' + filePath;
      const fileDir = require('path').dirname(localPath);
      if (fileDir != '.') fs.mkdirSync(fileDir, { recursive: true });
      fs.writeFileSync(localPath, text);
      console.log('saved local file: '+localPath)
      const sha256 = require("crypto").createHash("sha256").update(text).digest("hex");
      const nixName = camelCase(filePath);
      const file = { path: filePath, nixName, url, md5: '', sha256 };
      console.dir(file);
      fileList.push(file);
      break
    }
  }
  if (conanmanifest == null) {
    nixString += `# error: not found ${pkgId} = ${pname}/${version}/${user}/${channel} on any remote`;
    continue // next dep
  }
  const remoteFilesUrl = `${remote}${remoteFilesDir}`;
  const url = `${remote}${remoteFilesDir}/`
  console.log(`url = ${url}`);
  const response = await fetch(url);
  const data = await response.json();
  const remoteFileList = Object.keys(data.files); // TODO recursive?
  if (Object.values(data.files).find(obj => Object.keys(obj).length > 0)) {
    nixString += `# error: not implemented: nested remote files -> missing files. directory listing = ${await response.text()}`;
  }

  // parse conanmanifest.txt
  // skip line 1: looks like a file size in bytes
  //for (const fileLine of conanmanifest.trim().split('\n').slice(1)) {
    //const [, filePath, md5] = fileLine.match(/^(.*): (.*)$/);
  for (const filePath of remoteFileList) {
    const url = `${remote}${remoteFilesDir}/${filePath}`
    console.log(`url = ${url}`);
    const response = await fetch(url);
    const buffer = await response.buffer(); // binary or text

    // debug: verify checksums
    const localPath = 'temp/' + filePath;
    const fileDir = require('path').dirname(localPath);
    if (fileDir != '.') fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(localPath, buffer);
    console.log('saved local file: '+localPath)
    const sha256 = require("crypto").createHash("sha256").update(buffer).digest("hex");
    const nixName = camelCase(filePath);
    const file = { path: filePath, nixName, url, sha256 };
    console.dir(file);
    fileList.push(file);
  }

console.dir(fileList);

nixString += `

    # pname = ${pname}
    # version = ${version}
    # user = ${user}
    # channel = ${channel}
    # rev = ${rev}
    "${pkgId}" = stdenv.mkDerivation rec {
      pname = "${pkgClean}";
      version = "${rev}";
      remoteFilesUrl = ${JSON.stringify(remoteFilesUrl)};
${fileList.map(file => {

// TODO can we remove `name = "${file.path}";`?

return `\
      ${file.nixName} = fetchurl {
        url = "$\{remoteFilesUrl}/${file.path}";
        name = "${file.path}";
        sha256 = "${file.sha256}";
      };
`;
}).join('')}\
      srcs = [${fileList.map(file => file.nixName).join(' ')}];
      unpackPhase = "true"; # dont unpack (return true)
      installPhase = ''
        home=home/conan # convention (proposed convention)
        path=\$home/.conan/data/${pname}/${version}/${user}/${channel}

        mkdir -p \$out/\$path/dl/export
        ${fileList.filter(file => file.path.endsWith('.tgz')).map(file => {
          return `cp \${${file.nixName}} \$out/\$path/dl/export/${file.path}`; // TODO mkdir recursive
        }).join('\n        ')}

        mkdir -p \$out/\$path/export
        ${fileList.filter(file => !file.path.endsWith('.tgz')).map(file => {
          return `cp \${${file.nixName}} \$out/\$path/export/${file.path}`; // TODO mkdir recursive
        }).join('\n        ')}
      '';
      #license = "TODO";
      #homepage = "TODO";
    };

`;

  // debug
  numDone++;
  if (!processAllDeps || numDone == maxDone) break;

}

nixString += '  };\n'

console.log(nixString);

}

main();
