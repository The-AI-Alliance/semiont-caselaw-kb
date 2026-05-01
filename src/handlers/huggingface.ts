/**
 * HuggingFace Handler
 *
 * Downloads and processes datasets from HuggingFace
 */

import { writeFileSync, readFileSync } from 'node:fs';
import type { DatasetHandler, DatasetYamlConfig } from './types.js';
import type { DocumentInfo } from '../types.js';
import { fetchFirstNDocuments, convertLegalCaseDocument } from '../huggingface.js';
import { printInfo, printSuccess } from '../display.js';

export const huggingfaceHandler: DatasetHandler = {
  download: async (config: DatasetYamlConfig) => {
    if (!config.dataset) {
      throw new Error('HuggingFace handler requires dataset in config');
    }
    if (!config.cacheFile) {
      throw new Error('HuggingFace handler requires cacheFile in config');
    }

    const count = config.count || 10;
    printInfo(`Fetching ${count} documents from ${config.dataset}...`);
    const rawDocs = await fetchFirstNDocuments(config.dataset, count);
    const documents = rawDocs.map((doc, i) => convertLegalCaseDocument(doc, i));
    printSuccess(`Fetched ${documents.length} legal documents`);

    documents.forEach((doc, i) => {
      printInfo(`  ${i + 1}. ${doc.title} (${doc.content.length.toLocaleString()} chars)`, 3);
    });

    writeFileSync(config.cacheFile, JSON.stringify(documents, null, 2));
    printSuccess(`Saved to ${config.cacheFile}`);
  },

  load: async (config: DatasetYamlConfig) => {
    if (!config.cacheFile) {
      throw new Error('HuggingFace handler requires cacheFile in config');
    }

    printInfo(`Loading from ${config.cacheFile}...`);
    const data = readFileSync(config.cacheFile, 'utf-8');
    const documents: DocumentInfo[] = JSON.parse(data);
    printSuccess(`Loaded ${documents.length} legal documents`);

    documents.forEach((doc, i) => {
      printInfo(`  ${i + 1}. ${doc.title}`, 3);
    });

    return documents;
  },
};
