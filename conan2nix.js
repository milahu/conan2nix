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

// TODO nixNameOf: avoid collisions -> append -1 -2 -3 etc



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
const fetch = require('node-fetch')

const conanGraph = JSON.parse(fs.readFileSync(conanGraphFile, 'utf8'));

// TODO we need both! lock file and graph file
// graph has remote hashes, lock has local hashes

const crypto = require("crypto");
const sha256sum = s => crypto.createHash("sha256").update(s).digest("hex");
const sha1sum = s => crypto.createHash("sha1").update(s).digest("hex");
const md5sum = s => crypto.createHash("md5").update(s).digest("hex");

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



// https://flaviocopes.com/how-to-uppercase-first-letter-javascript/
const capitalize = (s) => {
  if (typeof s !== 'string') return ''
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}
const camelCase = s => s.split(/[._/-]/).map((part, idx) => (idx == 0) ? part : capitalize(part)).join('')

// avoid collisions
const nixNamesUsed = new Set();
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
let nixString = '';
nixString += indent + '{ stdenv, fetchurl, writeText }: {\n'



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

  console.log(`+ ${dep.reference}`);

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

  remoteFilesUrl = {
    base: `${graphNode.remote.url}/v2/conans/${nvuc}/revisions/${graphNode.revision}`,
    exportSuffix: '/files',
    packageSuffix: `/packages/${graphNode.id}/revisions/${graphNode.package_revision}` + '/files',
  };
  remoteFilesUrl.export = remoteFilesUrl.base + remoteFilesUrl.exportSuffix;
  remoteFilesUrl.package = remoteFilesUrl.base + remoteFilesUrl.packageSuffix;

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
      let download = false;
      const checksums = {};
      if (fs.existsSync(localPath)) {
        // verify local file
        const response = await fetch(url, { method: 'HEAD' });
        // curl -IL https://conan.bintray.com/v2/conans/bzip2/1.0.8/conan/stable/revisions/0/packages/da606cf731e334010b0bf6e85a2a6f891b9f36b0/revisions/0/files/conan_package.tgz
        // Content-Length: 101676
        // X-Checksum-Sha2: 207cb881aff65e7f71f561bdfb632882724e0811ed2b2721b90ab5eeda4cb3aa
        const sha256Remote = response.headers.get('x-checksum-sha2'); // single source of truth (trust the server)
        checksums.sha256 = sha256Remote;
        const sizeRemote = response.headers.get('content-length');
        const sizeLocal = fs.statSync(localPath).size;
        if (sizeRemote != sizeLocal) {
          console.log(`${graphNode._pname} ${scope}: size mismatch -> re-download ${localPath}`);
          download = true;
        }
        else {
          content = fs.readFileSync(localPath); // binary
          const sha256Local = crypto.createHash("sha256").update(content).digest("hex");
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
        content = isBinary ? await response.buffer() : await response.text();
        // TODO handle (content == null) -> update(content) says '"data" argument must be of type string or an instance of Buffer, ...' -> check http status
        if (!content) {
          console.dir({ response, contentType, isBinary, content });
        }
        const fileDir = require('path').dirname(localPath);
        if (fileDir != '.') fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(localPath, content, isBinary ? undefined : 'utf8');
      }
      checksums.sha256 = crypto.createHash("sha256").update(content).digest("hex");
      checksums.md5 = crypto.createHash("md5").update(content).digest("hex");
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

  const packageFileList = await getFileList('package');
  const packageManifest = await getManifest('package');

  // TODO remove
  // use 2 separate lists
  fileList.push(...exportFileList);
  fileList.push(...packageFileList);

  /*
  console.log('exportFileList:'); console.dir(exportFileList);
  console.log('exportManifest:'); console.dir(exportManifest.data);

  console.log('packageFileList:'); console.dir(packageFileList);
  console.log('packageManifest:'); console.dir(packageManifest.data);
  */

  // TODO download all files in exportFileList and packageFileList
  // TODO get checksums for nix fetchurl



  // FIXME ...
  //continue;

  /* multi line style:
      ${file.nixName} = fetchurl {
      url = "$\{url-${file.scope}}/${file.name}";
      sha256 = "${file.sha256}";
    };
  */

const nixFragment = `
  "${dep.reference}" =
  with
    url-base = "${remoteFilesUrl.base}";
    url-export = "\${url-base}${remoteFilesUrl.exportSuffix}";
    url-package = "\${url-base}${remoteFilesUrl.packageSuffix}";
  in
  stdenv.mkDerivation rec {
    pname = "${pname}";
    version = "${version}-${dep.revision}";
${fileList.map(file => {

/* conan should do the extracting
      # extract conandata.yml
      ${fileList.filter(f => f.path == 'conan_export.tgz').map(file => {
        return `tar xvf \${${file.nixName}} -C \$out/\$path/export/`;
      }).join('\n      ')}
*/
//      name = "${file.name}"; # TODO can we remove name?
return `\
    ${file.nixName} = fetchurl { url = "$\{url-${file.scope}}/${file.name}"; sha256 = "${file.sha256}"; };
`;
}).join('')}\
    metadata-json = writeText "metadata.json" ''
${fs.readFileSync(`${process.env.HOME}/.conan/data/${nvuc}/metadata.json`, 'utf8')}
    '';
    srcs = [${fileList.filter(f => f.download).map(file => file.nixName).join(' ')} metadata-json];
    unpackPhase = "true"; # dont unpack (return true)
    # path is relative to \$CONAN_USER_HOME/.conan/data
    installPhase = ''
      path=${pname}/${version}/${user}/${channel}

      mkdir -p \$out/\$path/dl/export
      ${fileList.filter(f => f.scope == 'export' && f.name.endsWith('.tgz') == true).map(file => {
        return `cp \${${file.nixName}} \$out/\$path/dl/export/${file.name}`;
      }).join('\n      ')}

      mkdir -p \$out/\$path/export
      ${fileList.filter(f => f.scope == 'export' && f.name.endsWith('.tgz') == false).map(file => {
        return `cp \${${file.nixName}} \$out/\$path/export/${file.name}`;
      }).join('\n      ')}

      mkdir -p \$out/\$path/dl/pkg/${dep.id}
      ${fileList.filter(f => f.scope == 'package' && f.name.endsWith('.tgz') == true).map(file => {
        return `cp \${${file.nixName}} \$out/\$path/dl/pkg/${dep.id}/${file.name}`;
      }).join('\n      ')}

      mkdir -p \$out/\$path/export
      ${fileList.filter(f => f.scope == 'package' && f.name.endsWith('.tgz') == false).map(file => {
        return `cp \${${file.nixName}} \$out/\$path/package/${dep.id}/${file.name}`;
      }).join('\n      ')}

      # TODO does conan require the metadata.json file? its created by conan ...
      cp \${metadata-json} \$out/\$path/metadata.json
    '';

    # TODO move to meta
    license = "${dep.license[0]}"; # TODO convert to nix license format
    homepage = "${dep.homepage}"; # TODO skip if empty
    url = "${dep.url}"; # TODO skip if empty
  };

`.replace(/^/, indent);

nixString += nixFragment;

console.log(`${graphNode.reference} nixFragment:`)
console.log(nixFragment);
console.log(`:nixFragment for ${graphNode.reference}`)

numDone++;
if (!processAllDeps || numDone == maxDone) break;

}




nixString += indent+'}\n'

//console.log(nixString);
fs.writeFileSync(outputFile, nixString, 'utf8');
console.log(`done: ${outputFile}`);

}

main();
