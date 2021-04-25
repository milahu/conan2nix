# conan2nix

... so we can build [google-orbit](https://github.com/google/orbit) on nixos

https://github.com/NixOS/nixpkgs/issues/94555

## sample output

`nix-conan-cache/abseil/20200923.3/_/_/export.nix`

```nix
{ lib, stdenv, fetchurl, writeText }:
let
  url-base = "https://conan.bintray.com/v2/conans/abseil/20200923.3/_/_/revisions/b2d602ea9f45c5bb738956d0f7aafa3d";
  url-export = "${url-base}/files";
  url-package = "${url-base}/packages/b911f48570f9bb2902d9e83b2b9ebf9d376c8c56/revisions/d65ce147e5eacfc4eb61c65f3c29744b/files";
in
stdenv.mkDerivation rec {
  pname = "abseil";
  version = "20200923.3-b2d602ea9f45c5bb738956d0f7aafa3d--force-rebuild";
  conan-reference = "abseil/20200923.3";
    conan_export-tgz = fetchurl { url = "${url-export}/conan_export.tgz"; sha256 = "1d770344954aadff19f12e3cd1be3ae687b3ed8d27c6d14a669caf554551e965"; };
    conan_sources-tgz = fetchurl { url = "${url-export}/conan_sources.tgz"; sha256 = "540293634a3b583996bd6e7fbff83c5a793e28fb463555f1119eefb094844c13"; };
    conanmanifest-txt = fetchurl { url = "${url-export}/conanmanifest.txt"; sha256 = "33fc4986b58fadc72f420b1c025cdfb456446460dbfecc90fcd5267bbd6e9c6d"; };
    conanfile-py = fetchurl { url = "${url-export}/conanfile.py"; sha256 = "57fc8d524fd61b75a619534d9d700ae00d056d76a7b2187fb909fe96dab8f314"; };
    conaninfo-txt = fetchurl { url = "${url-package}/conaninfo.txt"; sha256 = "2bd09438aeaed51559486d928d15f9929ddb7bfd87ca7d8a40694ae2afad4f1d"; };
    conan_package-tgz = fetchurl { url = "${url-package}/conan_package.tgz"; sha256 = "3938a658f83abc2360512d48dd7630f8f3ce89267bec16f282cf165240fcf8e2"; };
    conanmanifest-txt-2 = fetchurl { url = "${url-package}/conanmanifest.txt"; sha256 = "48636fbfafad647762efd3779a5b856f5ee88ad74199df9e3a3fc81a89ecad94"; };
  metadata-json = writeText "metadata.json" ''
    {"recipe": {"revision": "b2d602ea9f45c5bb738956d0f7aafa3d", "remote": "conan-center", "properties": {}, "checksums": {"conan_export.tgz": {"md5": "8a0c57a283c2ab579e676b2bc2ee6565", "sha1": "51776f21a4bc3ed9177d8663e24907efe3583ea7"}, "conanmanifest.txt": {"md5": "a4997bb29975190163371a3f81543159", "sha1": "debdb80c399f5f5d4a33b60bc2a80bddc982e42f"}, "conanfile.py": {"md5": "74addcc109f4e606abf57d75590d4540", "sha1": "a7afe538be9b315a4db92a9d7ea22921584531b8"}}}, "packages": {}}
  '';
  srcs = [conan_export-tgz conan_sources-tgz conanmanifest-txt conanfile-py conaninfo-txt conan_package-tgz conanmanifest-txt-2 metadata-json];
  phases = "installPhase";
  # path is relative to $CONAN_USER_HOME/.conan/data
  installPhase = ''
    path=abseil/20200923.3/_/_

    mkdir -p $out/$path/dl/export
    cp ${conan_export-tgz} $out/$path/dl/export/conan_export.tgz
    cp ${conan_sources-tgz} $out/$path/dl/export/conan_sources.tgz

    mkdir -p $out/$path/export
    cp ${conanmanifest-txt} $out/$path/export/conanmanifest.txt
    cp ${conanfile-py} $out/$path/export/conanfile.py

    mkdir -p $out/$path/dl/pkg/b911f48570f9bb2902d9e83b2b9ebf9d376c8c56
    cp ${conan_package-tgz} $out/$path/dl/pkg/b911f48570f9bb2902d9e83b2b9ebf9d376c8c56/conan_package.tgz

    mkdir -p $out/$path/package/b911f48570f9bb2902d9e83b2b9ebf9d376c8c56
    cp ${conaninfo-txt} $out/$path/package/b911f48570f9bb2902d9e83b2b9ebf9d376c8c56/conaninfo.txt
    cp ${conanmanifest-txt-2} $out/$path/package/b911f48570f9bb2902d9e83b2b9ebf9d376c8c56/conanmanifest.txt

    # TODO does conan require the metadata.json file?
    cp ${metadata-json} $out/$path/metadata.json
  '';

  meta = with lib; {
    description = "A Coq/SSReflect Library for Monoidal Rings and Multinomials";
    homepage = "https://github.com/abseil/abseil-cpp";
    url = "https://github.com/conan-io/conan-center-index";
    license = licenses.asl20;
  };
}
```

build:

```bash
nix-build -E 'with import <nixpkgs> { }; callPackage ./nix-conan-cache/abseil/20200923.3/_/_/export.nix {}'
```

## related

https://github.com/conan-io/conan/issues/4668 # Cache Downloads

> If you do not want to download anything all the time then you could use conan's export_sources feature  
> https://docs.conan.io/en/latest/reference/conanfile/attributes.html#exports-sources

https://github.com/conan-io/conan/pull/6287 # Feature/download cache

> Implement a download cache, which can be shared and concurrently used among different conan user homes

https://github.com/conan-io/conan/issues/6754 # [question] Offline - Extracting dependency tree with conan_api (without remotes)

> You might want to have a look to the generated conan.lock lockfile when you do a conan install or similar.  
> It has encoded the whole graph. There are other commands that will output a json with dependencies information too.  
> `conan info poco/1.9.4@ --json=file.json`  
> The file.json file will contain the dependencies.  
> The conan info command will not use the internet if the packages are already in the cache.

https://github.com/conan-io/conan/issues/6727 # [question] conan info|install skips cache and tries to find package from remote instead?

> I've exported a package to my local cache successfully. I've disabled the default remote because I want to work locally.

https://github.com/conan-io/conan/issues/5938 # [feature] using conan offline - normaly handle existent file in tools.download (uploader_downloader.py)

https://github.com/conan-io/conan/issues/5575 # [Question] Offline usage without remote

> in an offline environment I would suggest copying local cache from the one installed when online  
> recipes like OpenSSL are downloading the sources from the internet.  
> So even if you have the source code for the recipe,  
> you will not be able to create the package locally  
