import { pathToFileURL } from 'node:url';
/** Use the already locked runtime tarballs; never depend on cached registry metadata. */
export function consumerInstallation(manifest, packed, archivePath, sourceLock) {
  if (sourceLock.lockfileVersion !== 3 || !sourceLock.packages)
    throw Error('Consumer verification requires the version-3 repository lockfile.');
  if (!packed.integrity || !packed.integrity.startsWith('sha512-'))
    throw Error('Packed archive must provide its integrity digest.');
  const archive = pathToFileURL(archivePath).href;
  const consumer = {
    name: 'pulse-package-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { [manifest.name]: archive },
  };
  const runtime = Object.fromEntries(
    Object.entries(sourceLock.packages).filter(([path, value]) => path && !value.dev),
  );
  for (const name of Object.keys(manifest.dependencies ?? {}))
    if (!runtime['node_modules/' + name]) throw Error('Missing locked runtime dependency: ' + name);
  const entry = {
    version: manifest.version,
    resolved: archive,
    integrity: packed.integrity,
    license: manifest.license,
    engines: manifest.engines,
    bin: manifest.bin,
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    peerDependenciesMeta: manifest.peerDependenciesMeta,
  };
  const lock = {
    name: consumer.name,
    version: consumer.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: consumer.name, version: consumer.version, dependencies: consumer.dependencies },
      ['node_modules/' + manifest.name]: entry,
      ...runtime,
    },
  };
  return { consumer, lock };
}
