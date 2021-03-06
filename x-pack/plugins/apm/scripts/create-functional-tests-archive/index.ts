/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { argv } from 'yargs';
import { execSync } from 'child_process';
import moment from 'moment';
import path from 'path';
import fs from 'fs';
import { stampLogger } from '../shared/stamp-logger';

async function run() {
  stampLogger();

  const archiveName = 'apm_8.0.0';

  // include important APM data and ML data
  const indices =
    'apm-*-transaction,apm-*-span,apm-*-error,apm-*-metric,.ml-anomalies*,.ml-config';

  const esUrl = argv['es-url'] as string | undefined;

  if (!esUrl) {
    throw new Error('--es-url is not set');
  }
  const kibanaUrl = argv['kibana-url'] as string | undefined;

  if (!kibanaUrl) {
    throw new Error('--kibana-url is not set');
  }
  const gte = moment().subtract(1, 'hour').toISOString();
  const lt = moment(gte).add(30, 'minutes').toISOString();

  // eslint-disable-next-line no-console
  console.log(`Archiving from ${gte} to ${lt}...`);

  // APM data uses '@timestamp' (ECS), ML data uses 'timestamp'

  const rangeQueries = [
    {
      range: {
        '@timestamp': {
          gte,
          lt,
        },
      },
    },
    {
      range: {
        timestamp: {
          gte,
          lt,
        },
      },
    },
  ];

  // some of the data is timeless/content
  const query = {
    bool: {
      should: [
        ...rangeQueries,
        {
          bool: {
            must_not: [
              {
                exists: {
                  field: '@timestamp',
                },
              },
              {
                exists: {
                  field: 'timestamp',
                },
              },
            ],
          },
        },
      ],
      minimum_should_match: 1,
    },
  };

  const archivesDir = path.join(__dirname, '.archives');
  const root = path.join(__dirname, '../../../../..');

  // create the archive

  execSync(
    `node scripts/es_archiver save ${archiveName} ${indices} --dir=${archivesDir} --kibana-url=${kibanaUrl} --es-url=${esUrl} --query='${JSON.stringify(
      query
    )}'`,
    {
      cwd: root,
      stdio: 'inherit',
    }
  );

  const targetDirs = ['trial', 'basic'];

  // copy the archives to the test fixtures

  await Promise.all(
    targetDirs.map(async (target) => {
      const targetPath = path.resolve(
        __dirname,
        '../../../../test/apm_api_integration/',
        target
      );
      const targetArchivesPath = path.resolve(
        targetPath,
        'fixtures/es_archiver',
        archiveName
      );

      if (!fs.existsSync(targetArchivesPath)) {
        fs.mkdirSync(targetArchivesPath);
      }

      fs.copyFileSync(
        path.join(archivesDir, archiveName, 'data.json.gz'),
        path.join(targetArchivesPath, 'data.json.gz')
      );
      fs.copyFileSync(
        path.join(archivesDir, archiveName, 'mappings.json'),
        path.join(targetArchivesPath, 'mappings.json')
      );

      const currentConfig = {};

      // get the current metadata and extend/override metadata for the new archive
      const configFilePath = path.join(targetPath, 'archives_metadata.ts');

      try {
        Object.assign(currentConfig, (await import(configFilePath)).default);
      } catch (error) {
        // do nothing
      }

      const newConfig = {
        ...currentConfig,
        [archiveName]: {
          start: gte,
          end: lt,
        },
      };

      fs.writeFileSync(
        configFilePath,
        `export default ${JSON.stringify(newConfig, null, 2)}`,
        { encoding: 'utf-8' }
      );
    })
  );

  fs.unlinkSync(path.join(archivesDir, archiveName, 'data.json.gz'));
  fs.unlinkSync(path.join(archivesDir, archiveName, 'mappings.json'));
  fs.rmdirSync(path.join(archivesDir, archiveName));
  fs.rmdirSync(archivesDir);

  // run ESLint on the generated metadata files

  execSync('node scripts/eslint **/*/archives_metadata.ts --fix', {
    cwd: root,
    stdio: 'inherit',
  });
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.log(err);
    process.exit(1);
  });
