// Reads an EnergyPlus .eso results file from disk with the shared parser (src/model/eso.js).
// Returns { series: Map("KEY|Variable name|Frequency" -> number[]), find(variable, key, frequency) }.
import { readFileSync } from 'node:fs';
import { parseEso } from '../src/model/eso.js';

export const readEso = (file, keep) => parseEso(readFileSync(file, 'utf8'), keep);
