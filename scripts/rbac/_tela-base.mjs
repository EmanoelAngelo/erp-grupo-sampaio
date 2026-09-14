// Base do classificador da fatia tela-rotas-menu. Só leitura de catalogo.json.
import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import fs from 'node:fs';
const DIR = PASTA_RBAC;
export const CATALOGO = JSON.parse(fs.readFileSync(`${DIR}/catalogo.json`, 'utf8'));
const PERFIS = new Map(CATALOGO.map((c) => [c.code, c.perfis_de_hoje]));

export const ORDEM = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador'];
export const TODOS = [...ORDEM];
const D = ['admin_geral', 'gestor'];
export const AMB = {
  pdv: ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'],
  oficina: ['mecanico'],
  gestao: [...D, 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'],
  contabilidade: ['contador'],
};
export const ROTA = {
  ROTA_PDV: ['pdv', 'gestao'], ROTA_OFICINA: ['oficina', 'gestao'], ROTA_GESTAO: ['gestao'],
  ROTA_CAIXA: ['pdv', 'gestao'], ROTA_CONTABILIDADE: ['contabilidade', 'gestao'],
};
const G = ['gerente_loja', 'gerente_oficina'];
const CX = ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'];
export const LISTAS = {
  DONOS_DO_GRUPO: [...D],
  QUEM_MONTA_O_CATALOGO: [...D, ...G, 'estoquista'],
  QUEM_RESPONDE_PELA_LOJA: [...D, ...G],
  QUEM_COTA_FRETE: [...D, 'gerente_loja', 'estoquista'],
  QUEM_ENTREGA_A_CONTABILIDADE: [...D, ...G, 'contador'],
  QUEM_GERENCIA_A_OPERACAO: [...D, ...G],
  QUEM_EMITE_NOTA: [...D, ...G, ...CX],
  QUEM_ATENDE_O_CLIENTE: [...D, ...G, 'atendente', 'operador_caixa_loja'],
  QUEM_DESFAZ_VENDA: [...D, ...G, 'estoquista', 'atendente', ...CX],
  QUEM_CONTA_A_PRATELEIRA: [...D, ...G, 'estoquista'],
  QUEM_CONCILIA_RECEBIMENTO: [...D, ...G, 'estoquista'],
  QUEM_DEVOLVE_AO_FORNECEDOR: [...D, ...G, 'estoquista'],
  QUEM_VE_A_CONSIGNACAO: [...D, ...G, 'estoquista', 'atendente', ...CX],
};
export const ordenar = (xs) => ORDEM.filter((p) => xs.includes(p));
export function alcanceTela(envs, perfis) {
  const doAmb = envs.flatMap((e) => AMB[e]);
  return ordenar(perfis ? doAmb.filter((p) => perfis.includes(p)) : doAmb);
}
// Alcance de uma expressão de capability com os modelos dia-1 (perfis_de_hoje do catálogo).
export function alcanceCap(expr) {
  if (expr === 'PUBLICA' || expr === 'SO_AUTENTICADO') return TODOS;
  if (expr.startsWith('FALTA:')) return null;
  const m = expr.match(/^(qualquer|todas)\((.*)\)$/);
  const codes = m ? m[2].split(',').map((s) => s.trim()) : [expr];
  for (const c of codes) if (!PERFIS.has(c)) throw new Error(`capability fora do catálogo: ${c}`);
  const sets = codes.map((c) => PERFIS.get(c));
  const r = !m || m[1] === 'qualquer' ? sets.flat() : ORDEM.filter((p) => sets.every((s) => s.includes(p)));
  return ordenar([...new Set(r)]);
}
const CURTO = { admin_geral: 'admin_geral', gestor: 'gestor', gerente_loja: 'gerente_loja', gerente_oficina: 'gerente_oficina',
  estoquista: 'estoquista', atendente: 'atendente', operador_caixa: 'operador_caixa(legado)', operador_caixa_loja: 'operador_caixa_loja',
  operador_caixa_oficina: 'operador_caixa_oficina', mecanico: 'mecanico', contador: 'contador' };
// Frase de equivalência dia-1 da TELA: o que a tela deixa de mostrar / passa a mostrar.
export function diffDia1(hoje, expr) {
  const novo = alcanceCap(expr);
  if (!novo) return 'Dia 1: sem capability no catálogo (FALTA) — não dá para medir.';
  const perde = hoje.filter((p) => !novo.includes(p)).map((p) => CURTO[p]);
  const ganha = novo.filter((p) => !hoje.includes(p)).map((p) => CURTO[p]);
  if (!perde.length && !ganha.length) return 'Dia 1: igual (mesmo conjunto de perfis que hoje).';
  const partes = [];
  if (perde.length) partes.push(`deixa de abrir para ${perde.join(', ')}`);
  if (ganha.length) partes.push(`passa a abrir para ${ganha.join(', ')}`);
  return `Dia 1: DESVIO — ${partes.join('; ')}.`;
}
