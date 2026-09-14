/**
 * T2 do RBAC granular para o modelo `operador_caixa`: ver `varrer.ts`. Um arquivo por
 * modelo, para o vitest distribuir os onze entre os processos.
 */
import { varrerComo } from './varrer.js';

varrerComo('operador_caixa');
