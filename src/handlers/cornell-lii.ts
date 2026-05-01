/**
 * Cornell LII Handler
 *
 * Downloads and processes legal opinions from Cornell Legal Information Institute
 */

import { writeFileSync, readFileSync } from 'node:fs';
import type { DatasetHandler, DatasetYamlConfig } from './types.js';
import { downloadCornellLII, formatLegalOpinion } from '../legal-text.js';
import { printInfo, printSuccess } from '../display.js';

export const cornellLiiHandler: DatasetHandler = {
  download: async (config: DatasetYamlConfig) => {
    if (!config.url) {
      throw new Error('Cornell LII handler requires url in config');
    }
    if (!config.cacheFile) {
      throw new Error('Cornell LII handler requires cacheFile in config');
    }

    printInfo('Downloading from Cornell LII...');
    const rawText = await downloadCornellLII(config.url);
    printSuccess(`Downloaded ${rawText.length.toLocaleString()} characters`);

    writeFileSync(config.cacheFile, rawText);
    printSuccess(`Saved to ${config.cacheFile}`);
  },

  load: async (config: DatasetYamlConfig) => {
    if (!config.cacheFile) {
      throw new Error('Cornell LII handler requires cacheFile in config');
    }

    printInfo(`Loading from ${config.cacheFile}...`);
    const rawText = readFileSync(config.cacheFile, 'utf-8');
    printSuccess(`Loaded ${rawText.length.toLocaleString()} characters`);

    printInfo('Formatting with markdown...');
    // Extract case info from config or use defaults
    const caseTitle = config.displayName;
    const citation = config.entityTypes?.find(t => t.match(/\d+ U\.S\. \d+/)) || 'Unknown citation';
    const formattedText = formatLegalOpinion(caseTitle, citation, rawText);
    printSuccess(`Formatted opinion: ${formattedText.length.toLocaleString()} characters`);

    return formattedText;
  },
};
