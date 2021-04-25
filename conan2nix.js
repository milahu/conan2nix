#!/usr/bin/env node

// conan2nix
// convert conan requirements to nix expressions
// generate version pins of conan dependencies
// similar to cargo2nix, cabal2nix, etc.

// license: "public domain" or "CC0-1.0"
// author: milahu, date: 2021-04-24

// usage of output file conancache.nix in default.nix:
// conancache = callPackage ./conancache.nix {};
// then populate the cache in $CONAN_USER_HOME/.conan/data/ with links or symlinks to files
// cp --archive --link /abs/path/to/src/dir/ path/to/dest
// cp --archive --symbolic-link /abs/path/to/src/dir/ path/to/dest
// -> https://unix.stackexchange.com/questions/196537/how-to-copy-a-folder-structure-and-make-symbolic-links-to-files

// https://docs.conan.io/en/latest/reference.html
// TODO set CONAN_USER_HOME=$TMP/conan -> conan will use cache in $TMP/conan/.conan/data
// TODO set CONAN_READ_ONLY_CACHE=true -> but conan must extract tgz files
// TODO disable all remotes -> work offline
// TODO patch conan build files to use cached includes?

// debug
const processAllDeps = 1
const maxDone = 999999
const getActualChecksums = 1 // true: download all files for checksums



// base.lock has no package_id for deps (orbit/third_party/conan/lockfiles/base.lock)
// conan.lock is created by `conan lock create ....` -> get package_id for all deps
const conanLockFile = '/home/user/src/google-orbit/src/orbit/build_default_relwithdebinfo/conan.lock';

// conan-graph.json is created by `conan info . --json=conan-graph.json` in project root
const conanGraphFile = '/home/user/src/google-orbit/src/orbit/conan-graph.json';



const fs = require('fs');
const child_process = require('child_process');
//const node_fetch = require('node-fetch');

// https://stackoverflow.com/a/62500224/10440128
// fetch: add option keepAlive with default true
const fetch = (function getFetchWithKeepAlive() {
  const node_fetch = require('node-fetch');
  const http = require('http');
  const https = require('https');
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  return async function (url, userOptions) {
    const options = { keepAlive: true };
    Object.assign(options, userOptions);
    if (options.keepAlive == true)
      options.agent = (parsedUrl => parsedUrl.protocol == 'http:' ? httpAgent : httpsAgent);
    delete options.keepAlive;
    return await node_fetch(url, options);
  }
})();

// licenses used in conan graph: mostly spdx IDs:
// cat conan-graph.json | jq -r '.[].license[0]' | sort -u
// nix-build -E '(with import <nixpkgs> {}; with lib; with builtins; writeText "nix-license-map.json" ( toJSON (mapAttrs (n: v: v.spdxId) (filterAttrs (n: v: hasAttr "spdxId" v) licenses))))'
//const licenseSpdxOfNix = require('./license-nix-of-spdx.json');
const licenseSpdxOfNix = JSON.parse(JSON.parse(child_process.spawnSync('nix', ['eval', '(with import <nixpkgs> {}; with lib; with builtins; toJSON (mapAttrs (n: v: v.spdxId) (filterAttrs (n: v: hasAttr "spdxId" v) licenses)))'], { encoding: 'utf8', windowsHide: true }).stdout))
const licenseNixOfSpdx = Object.fromEntries(Object.keys(licenseSpdxOfNix).map(nix => [licenseSpdxOfNix[nix], nix]));

const conanGraph = JSON.parse(fs.readFileSync(conanGraphFile, 'utf8'));

const crypto = require("crypto");
const sha256sum = s => crypto.createHash("sha256").update(s).digest("hex");
const md5sum = s => crypto.createHash("md5").update(s).digest("hex");

const outputFile = 'conan-cache.nix'; // index file with callPackage to all files in nixConanCacheDir
const localFilesDir = 'temp/';
const nixConanCacheDir = 'nix-conan-cache';

// parse remotes from orbit/third_party/conan/configs/linux/remotes.txt
const remotesText = `\
bintray https://api.bintray.com/conan/hebecker/orbitdeps True 
conan-center https://conan.bintray.com True 
bincrafters https://api.bintray.com/conan/bincrafters/public-conan True 
`;
const remoteEntries = remotesText.trim().split('\n').map(line => line.split(' ').slice(0, 2));
const remoteUrls = Object.fromEntries(remoteEntries); // lookup: name -> url
const remoteNames = Object.fromEntries(remoteEntries.map(([name, url]) => [url, name])); // reverse lookup: url -> name

// avoid collisions
// TODO add protected names from the stdenv.mkDerivation scope
let nixNamesUsed = new Set();
nixNamesUsed.add('fooBar'); // TODO add names
const nixNameOf = path => {
  const base = path.replace(/[./]/g, '-');
  let candidate = base;
  for (let i = 2; i < 9999; i++) {
    if (!nixNamesUsed.has(candidate)) {
      nixNamesUsed.add(candidate);
      return candidate;
    }
    candidate = `${base}-${i}`;
  }
}
// TODO avoid collisions -> append -1 -2 -3 etc
// conanmanifest-txt will always collide (export vs package), but maybe also other files

async function main() {

const conanLock = JSON.parse(fs.readFileSync(conanLockFile, 'utf8'));

//console.dir(conanLock.graph_lock.nodes);


const indent = '';



// process graph + lock file in one loop
// we extend the graph stucture, since its an array (lockfile is object)

const lockdataByFullref = Object.fromEntries(Object.values(conanLock.graph_lock.nodes).map(val => [val.ref, val]));

for (let nodeId = 0; nodeId < conanGraph.length; nodeId++) {
  const graphNode = conanGraph[nodeId];
  if (!graphNode.is_ref) continue;
  graphNode._fullref = `${graphNode.reference}#${graphNode.revision}`;
  graphNode._lockdata = lockdataByFullref[graphNode._fullref];
  if (!graphNode._lockdata) {
    console.dir([nodeId, graphNode]);
    throw `error: no lock data found for fullref ${graphNode._fullref}`;
  }
}



// loop graph-file

let numDone = 0
for (const dep of conanGraph) { // dep: dependecy, recipe, ...

  const graphNode = dep; // TODO rename
  //console.dir(dep);

  if (!dep.is_ref) continue;

  let [, pname, version, user, channel] = dep.reference.match(/^([^/]+)\/([^@#]+)(?:@([^/]+)\/([^#]+))?$/);
  if (!user) user = '_';
  if (!channel) channel = '_';

  dep._pname = pname;
  dep._version = version;
  dep._user = user;
  dep._channel = channel;

  const fileList = [];


  // parse manifest of export + package
  // manifests contain md5 checksums of all extracted files

  const nvuc = `${dep._pname}/${dep._version}/${dep._user}/${dep._channel}`;
  const prefix = `${process.env.HOME}/.conan/data/${nvuc}`;
  const exportManifestFile = `${prefix}/export/conanmanifest.txt`;
  const packageManifestFile = `${nvuc}/package/${dep._lockdata.package_id}/conanmanifest.txt`;

  const outputFileDir = `${nixConanCacheDir}/${nvuc}`;
  const outputFilePath = `${outputFileDir}/export.nix`; // TODO split export vs packages



  // debug
  if (pname != 'freetype-gl') continue;
/* TODO restore
  if (fs.existsSync(outputFilePath)) {
    console.log(`exists: ${outputFilePath} -> skip`)
    continue;
  }
*/



  console.log(`+ ${dep.reference}`);

  async function getManifest(scope) {
    const localPath = (scope == 'package') ? packageManifestFile : exportManifestFile;
    const text =
      fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') :
      await (async () => {
        const url = `${graphNode.remote.url}/v2/conans/${nvuc}/revisions/${graphNode.revision}` + (
          (scope == 'package') ? `/packages/${graphNode.id}/revisions/${graphNode.package_revision}` : ''
        ) + '/files/conanmanifest.txt';
        const response = await fetch(url);
        const text = await response.text();
        const fileDir = require('path').dirname(localPath);
        fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(localPath, text, 'utf8');
        return text;
      })();
    // parse manifest: filepaths + checksums
    // skip line 1: looks like a file size in bytes
    const data = Object.fromEntries(text.trim().split('\n').slice(1).map(fileLine => {
      const [, filePath, md5] = fileLine.match(/^(.*): (.*)$/);
      return [filePath, md5]
    }));
    return { text, data, localPath };
  }

  // TODO use dep.binary_remote
  // for example dep.binary_remote == 'bintray'
  // -> binary remote url = 'https://api.bintray.com/conan/hebecker/orbitdeps'
  remoteFilesUrl = {
    base: `${graphNode.remote.url}/v2/conans/${nvuc}/revisions/${graphNode.revision}`,
    exportSuffix: '/files',
    packageSuffix: `/packages/${graphNode.id}/revisions/${graphNode.package_revision}` + '/files',
  };
  remoteFilesUrl.export = remoteFilesUrl.base + remoteFilesUrl.exportSuffix;
  remoteFilesUrl.package = remoteFilesUrl.base + remoteFilesUrl.packageSuffix;

  // graphNode.binary: Cache, Download, Missing
  const hasPackage = graphNode.binary != 'Missing'; // -> 'Cache' or 'Download' (whats the diff?)

  // FIXME
  if (graphNode.binary == 'Missing') {
    throw `not implemented: build package from source = run conanfile.py script`;
  }

  async function getFileList(scope) {
    const filesUrl = remoteFilesUrl[scope];
    const response = await fetch(filesUrl);
    const data = await response.json();
    // reshape object to array
    const fileNameList = Object.keys(data.files);
    if (Object.values(data.files).find(obj => Object.keys(obj).length > 0)) {
      console.dir({ scope, filesUrl, data, fileList });
      throw `error: not implemented: nested remote files -> missing files`;
    }
    const fileList = [];
    for (const fileName of fileNameList) {
      const pathDir =
        (scope == 'package') ? (fileName.endsWith('.tgz') ? `dl/pkg/${dep._lockdata.package_id}` : `package/${dep._lockdata.package_id}`) :
        (scope == 'export') ? (fileName.endsWith('.tgz') ? `dl/export` : `export`) :
          null;
      // TODO simplify?
      const path = `${pathDir}/${fileName}`;
      const nvuc = `${dep._pname}/${dep._version}/${dep._user}/${dep._channel}`;
      const localPath = `${process.env.HOME}/.conan/data/${nvuc}/${path}`;
      const url = `${filesUrl}/${fileName}`;
      let content = null;
      let download = null;
      let sizeRemote = null;
      let sha256Remote = null;
      let etag = null;
      let md5Remote = null;
      const checksums = {};
      if (!fs.existsSync(localPath)) {
        download = true;
      }
      else {
        // verify local file
        const response = await fetch(url, { method: 'HEAD' });
        // curl -IL https://conan.bintray.com/v2/conans/bzip2/1.0.8/conan/stable/revisions/0/packages/da606cf731e334010b0bf6e85a2a6f891b9f36b0/revisions/0/files/conan_package.tgz
        // Content-Length: 101676
        // X-Checksum-Sha2: 207cb881aff65e7f71f561bdfb632882724e0811ed2b2721b90ab5eeda4cb3aa
        sizeRemote = response.headers.get('content-length');
        sha256Remote = response.headers.get('x-checksum-sha2'); // single source of truth (trust the server)

        // TODO also use other checksums, for example x-checksum-sha1

        etag = response.headers.get('etag');
        md5Remote = etag?.length == 32 ? etag : null;
        if (!sha256Remote) sha256Remote = etag?.length == 64 ? etag : null;

        checksums.sha256 = sha256Remote;
        const sizeLocal = fs.statSync(localPath).size;
        if (sizeRemote != sizeLocal) {
          console.log(`${graphNode._pname} ${scope}: size mismatch -> re-download ${localPath}`);
          download = true;
        }
        else {
          content = fs.readFileSync(localPath); // binary
          // TODO handle (content == null) -> update(content) says '"data" argument must be of type string or an instance of Buffer, ...' -> check http status
          if (!content) {
            console.dir({ localPath, content });
          }
          const sha256Local = sha256sum(content);
          if (sha256Remote != sha256Local) {
            console.log(`${graphNode._pname} ${scope}: checksum fail -> re-download ${localPath}`);
            download = true;
          }
          else {
            // local file is valid
            download = false;
            console.log(`${graphNode._pname} ${scope}: use ${fileName} from ${localPath} (checksum pass)`);
          }
        }
      }
      if (download) {
        console.log(`${graphNode._pname} ${scope}: get ${fileName} from ${url}`);
        const response = await fetch(url);

        const contentType = response.headers.get('content-type'); // trust the server ... otherwise use https://github.com/sindresorhus/file-type
        const isBinary = !(contentType.split('/')[0] == 'text' || contentType.split('/')[1] == 'json');

        if (!sizeRemote) sizeRemote = response.headers.get('content-length');

        if (!sha256Remote) sha256Remote = response.headers.get('x-checksum-sha2'); // single source of truth (trust the server)
        etag = response.headers.get('etag');
        md5Remote = etag?.length == 32 ? etag : null;
        if (!sha256Remote) sha256Remote = etag?.length == 64 ? etag : null;

        content = isBinary ? await response.buffer() : await response.text();
        // TODO handle (content == null) -> update(content) says '"data" argument must be of type string or an instance of Buffer, ...' -> check http status
        if (!content) {
          console.dir({ localPath, response, contentType, isBinary, content });
        }
        const fileDir = require('path').dirname(localPath);
        if (fileDir != '.') fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(localPath, content, isBinary ? undefined : 'utf8');

        // copy paste. todo refactor (here we have isBinary)
        const sizeLocal = fs.statSync(localPath).size;
        if (
          sizeRemote != null && // some servers dont send content-length -> validate only with sha256
          sizeRemote != sizeLocal
        ) {
          console.dir({ localPath, sizeLocal, sizeRemote, url, headers: response.headers.raw() });
          throw `${graphNode._pname} ${scope}: size mismatch in download ${localPath} from ${url}`;
        }
        content = fs.readFileSync(localPath, isBinary ? undefined : 'utf8');
        if (!content) {
          throw `${graphNode._pname} ${scope}: empty file in download ${localPath} from ${url}`;
        }
        const sha256Local = sha256sum(content);
        const md5Local = md5sum(content);
        // FIXME some remotes dont send x-checksum-sha2 header ... -> use etag header (md5?)
        let checksumPass = false; // at least one checksum pass?
        if (sha256Remote != null) {
          if (sha256Remote == sha256Local) checksumPass = true;
          else {
            console.dir({ localPath, sha256Local, sha256Remote, url, headers: response.headers.raw() });
            throw `${graphNode._pname} ${scope}: checksum fail in download ${localPath} from ${url}`;
          }
        }
        if (md5Remote != null) {
          if (md5Remote == md5Local) checksumPass = true;
          else {
            console.dir({ localPath, md5Local, md5Remote, url, headers: response.headers.raw() });
            throw `${graphNode._pname} ${scope}: checksum fail in download ${localPath} from ${url}`;
          }
        }
        if (checksumPass == false) {
          console.dir({ localPath, url, md5Local, md5Remote, sha256Local, sha256Remote, etag, headers: response.headers.raw() });
          throw `no checksum passed`;
        }

      }
      // TODO handle (content == null) -> update(content) says '"data" argument must be of type string or an instance of Buffer, ...' -> check http status
      if (!content) {
        console.dir({ localPath, content, download, url,  });
      }
      checksums.sha256 = sha256sum(content);
      checksums.md5 = md5sum(content);
      const file = {
        nixName: nixNameOf(fileName),
        localPath,
        name: fileName,
        url,
        ...checksums,
        scope,
      };
      fileList.push(file);
    }
    return fileList;
  }

  const exportFileList = await getFileList('export');
  const exportManifest = await getManifest('export');

  const packageFileList = hasPackage ? await getFileList('package') : [];
  const packageManifest = hasPackage ? await getManifest('package') : null;

  // TODO remove
  // use 2 separate lists
  fileList.push(...exportFileList);
  fileList.push(...packageFileList);

// TODO asssert: dep.license.length == 1
const nixLicense = (() => {
  const nixName = licenseNixOfSpdx[dep.license[0]];
  if (nixName) return `lib.licenses.${nixName}`;
  const customLicense = `{
    fullName = ${JSON.stringify(dep.license[0])};
  }`;
  console.log(`custom nixLicense: ${customLicense}`);
  return customLicense;
})();

// TODO add to conan-cache.nix:
//  "${dep.reference}" = callPackage ./conan-cache/path/to/file.nix {};
// -> crawl all files when done? (get dep.reference from attr conan-reference)

// TODO does conan require the metadata.json file?

// TODO use something simpler than stdenv.mkDerivation? (derivation?)

// phases: https://github.com/NixOS/nixpkgs/blob/master/pkgs/stdenv/generic/setup.sh#L1276

const nixString = `
{ lib, stdenv, fetchurl, writeText }:
let
  url-base = "${remoteFilesUrl.base}";
  url-export = "\${url-base}${remoteFilesUrl.exportSuffix}";
  ${hasPackage ? `url-package = "\${url-base}${remoteFilesUrl.packageSuffix}";` : ''}
in
stdenv.mkDerivation rec {
  pname = "${pname}";
  version = "${version}-${dep.revision}";
  conan-reference = "${dep.reference}";
${fileList.map(file => `\
    ${file.nixName} = fetchurl { url = "$\{url-${file.scope}}/${file.name}"; sha256 = "${file.sha256}"; };
`).join('')}\
  metadata-json = writeText "metadata.json" ''
    ${fs.readFileSync(`${process.env.HOME}/.conan/data/${nvuc}/metadata.json`, 'utf8')}
  '';
  srcs = [${fileList.map(file => file.nixName).join(' ')} metadata-json];
  phases = "checkPhase installPhase installCheckPhase distPhase";
  # path is relative to \$CONAN_USER_HOME/.conan/data
  installPhase = ''
    path=${pname}/${version}/${user}/${channel}

    mkdir -p \$out/\$path/dl/export
    ${exportFileList.filter(f => f.name.endsWith('.tgz') == true).map(file => {
      return `cp \${${file.nixName}} \$out/\$path/dl/export/${file.name}`;
    }).join('\n    ')}

    mkdir -p \$out/\$path/export
    ${exportFileList.filter(f => f.name.endsWith('.tgz') == false).map(file => {
      return `cp \${${file.nixName}} \$out/\$path/export/${file.name}`;
    }).join('\n    ')}

${!hasPackage ? '' : `
    mkdir -p \$out/\$path/dl/pkg/${dep.id}
    ${packageFileList.filter(f => f.name.endsWith('.tgz') == true).map(file => {
      return `cp \${${file.nixName}} \$out/\$path/dl/pkg/${dep.id}/${file.name}`;
    }).join('\n    ')}

    mkdir -p \$out/\$path/package/${dep.id}
    ${packageFileList.filter(f => f.name.endsWith('.tgz') == false).map(file => {
      return `cp \${${file.nixName}} \$out/\$path/package/${dep.id}/${file.name}`;
    }).join('\n    ')}
`}

    cp \${metadata-json} \$out/\$path/metadata.json
  '';

  meta = {
    description = ${JSON.stringify(dep.description)};
    license = ${nixLicense};
    ${dep.homepage ? `homepage = "${dep.homepage}";` : ''}
    ${dep.url ? `url = "${dep.url}";` : ''}
  };
}

`.replace(/^/, indent);


console.log(`${graphNode.reference} nixString:`)
console.log(nixString);
console.log(`:nixString for ${graphNode.reference}`)

fs.mkdirSync(outputFileDir, { recursive: true });
fs.writeFileSync(outputFilePath, nixString, 'utf8');
console.log(`done: ${outputFilePath}`);

numDone++;
if (!processAllDeps || numDone == maxDone) break;

nixNamesUsed = new Set(); // reset after each branchNode
// TODO add protected names from the stdenv.mkDerivation scope

}

}

main();
