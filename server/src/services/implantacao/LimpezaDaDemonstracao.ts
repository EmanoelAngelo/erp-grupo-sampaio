/**
 * ============================================================================
 * PREPARAR A ENTREGA: LIMPAR A DEMONSTRAÇÃO — `npm run db:limpar-demonstracao`
 * ============================================================================
 *
 * O roteiro em volta da transação de `db/limpezaDaDemonstracao.ts`:
 *
 *   SIMULAÇÃO (padrão) — abre o banco SÓ LEITURA e diz, tabela a tabela, o que
 *   sai e por quê; os produtos (nome) e as contas (login e nome) que saem; o
 *   que fica em dúvida; o que fica, com a contagem; e a IMPRESSÃO DIGITAL.
 *   Termina com o comando de aplicação já com a impressão.
 *
 *   APLICAÇÃO (`--aplicar <impressão>`), nesta ordem:
 *     1. assume o banco (a trava uma-instância-por-banco, GAP-PRD-137): com a
 *        API no ar, recusa e diz quem está usando;
 *     2. refaz o plano: impressão diferente, documento fiscal de PRODUÇÃO ou
 *        bloqueio → recusa, sem copiar e sem apagar;
 *     3. tira a CÓPIA DE SEGURANÇA (VACUUM INTO, com data no nome, conferida
 *        com integrity_check) e diz onde ficou — sem cópia, nada é apagado;
 *     4. roda a transação (que refaz o plano de novo, lá dentro, e confere que
 *        saiu exatamente o planejado — senão ROLLBACK);
 *     5. depois do COMMIT, move (não apaga) as fotos dos produtos que saíram
 *        para uma pasta de QUARENTENA, e diz qual;
 *     6. imprime as PROVAS (integrity_check, foreign_key_check, zero produtos,
 *        zero saldo, zero movimentos, zero contas da demonstração, as empresas,
 *        a configuração com o mesmo conteúdo de antes, a auditoria intacta mais
 *        a linha nova).
 *
 *   Rodar de novo depois de aplicada: nada a fazer, sai 0. A partir da linha
 *   de auditoria da limpeza, o que o banco tem é dado da operação, e este
 *   comando não toca nele.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDirectory, copiarBancoParaArquivo, verificarBackup } from '../../db/backup.js';
import {
  DivergenciaNaLimpeza,
  ImpressaoDivergente,
  LimpezaBloqueada,
  executarLimpeza,
  planejarLimpeza,
  provasDaLimpeza,
  type OpcoesDaLimpeza,
  type PastaDeArquivo,
  type Plano,
} from '../../db/limpezaDaDemonstracao.js';
import { getConnection, resolveDatabasePath } from '../../db/sqlite.js';
import { VARIAVEIS_DO_ACESSO_SEM_SENHA, valorLigado } from '../../config/acessoSemSenhaAposentado.js';
import { equipmentPhotosDir } from '../core/EquipmentPhotoService.js';
import { uploadsDir } from '../core/ProductImageService.js';
import { photosDir } from '../core/WorkshopPhotoService.js';
import { BancoOcupado, assumirInstanciaAgora, type Trava } from './instanciaUnica.js';

export interface ResultadoDoComando {
  /** 0 = feito, simulado ou nada a fazer; 1 = recusado ou falhou. */
  codigo: number;
  linhas: string[];
  /** A razão da recusa, quando houver (vai para a saída de erro). */
  recusa: string[];
  plano?: Plano;
  copia?: string;
  quarentena?: { pasta: string | null; movidos: number; ausentes: number };
}

const COMANDO = 'npm run db:limpar-demonstracao --prefix server --';
const COMANDO_NO_SERVIDOR = 'node server/dist/scripts/limpar-demonstracao.js';

function flagsDe(o: OpcoesDaLimpeza): string[] {
  return [
    ...(o.incluirClientes ? ['--incluir-clientes'] : []),
    ...(o.incluirFornecedor ? ['--incluir-fornecedor'] : []),
    ...(o.reiniciarSequenciasDeEtiqueta ? ['--reiniciar-sequencias-de-etiqueta'] : []),
  ];
}

function carimbo(agora: Date): string {
  return agora.toISOString().replace(/[:.]/g, '-');
}

function descreverPlano(plano: Plano, caminho: string, bancoExplicito: boolean): string[] {
  const l: string[] = [];
  l.push(`Banco: ${caminho}`);
  l.push(`Versão do núcleo no banco: ${plano.versaoDoNucleo ?? '—'}`);
  l.push('');
  l.push(`O que sai, tabela a tabela — ${plano.totalQueSai} linha(s) em ${plano.porTabela.length} tabela(s):`);
  for (const p of plano.passos) {
    if (p.situacao === 'ausente') {
      l.push(`  passo ${String(p.ordem).padStart(2)}  ${p.tabela}: não existe neste banco — pulado`);
      continue;
    }
    if (p.situacao === 'duvida_fica') continue;
    const total = Object.values(p.efeitos).reduce((s, n) => s + n, 0);
    if (total === 0) {
      l.push(`  passo ${String(p.ordem).padStart(2)}  ${p.tabela}: 0 — ${p.motivo}`);
      continue;
    }
    l.push(`  passo ${String(p.ordem).padStart(2)}  ${p.tabela}: ${p.efeitos[p.tabela] ?? 0} — ${p.motivo}`);
    const cascata = Object.entries(p.efeitos).filter(([t]) => t !== p.tabela);
    if (cascata.length > 0) l.push(`             em cascata: ${cascata.map(([t, n]) => `${t} ${n}`).join(', ')}`);
  }
  l.push('');
  l.push('Por tabela (antes → depois):');
  for (const t of plano.porTabela) {
    const origem = t.emCascata > 0 ? ` (${t.diretas} direta(s), ${t.emCascata} em cascata de ${t.cascataDe.join(', ')})` : '';
    l.push(`  ${t.tabela}: ${t.antes} → ${t.antes - t.saem}${origem}`);
  }
  l.push('');
  l.push(`Produtos que saem (${plano.produtos.length}):`);
  for (const p of plano.produtos) l.push(`  - ${p.nome}${p.codigo ? ` [${p.codigo}]` : ''}`);
  l.push(`Contas que saem (${plano.usuarios.length}):`);
  for (const u of plano.usuarios) l.push(`  - ${u.login} — ${u.nome}`);
  l.push('');
  l.push('Dúvidas (padrão: FICAM):');
  const c = plano.duvidas.clientes;
  l.push(
    `  - clientes citados pelos documentos de demonstração: ${c.citados} — `
      + (c.incluidos ? 'SAEM (--incluir-clientes)' : 'ficam (para tirar: --incluir-clientes)')
      + (c.porEmpresa.length ? `; ${c.porEmpresa.map((x) => `${x.empresa} desde ${x.criadoEm}`).join(', ')} (nome e documento não são impressos)` : ''),
  );
  const f = plano.duvidas.fornecedores;
  l.push(
    `  - fornecedor citado pela nota de teste: ${f.citados} — `
      + (f.incluidos ? 'SAI (--incluir-fornecedor)' : 'fica (para tirar: --incluir-fornecedor)')
      + (f.porEmpresa.length ? `; ${f.porEmpresa.map((x) => `${x.empresa} desde ${x.criadoEm}`).join(', ')}` : ''),
  );
  const s = plano.duvidas.sequenciasDeEtiqueta;
  l.push(
    `  - numeração de etiqueta (código de barras e plaquinha): ${s.linhas.map((x) => `${x.nome}@${x.empresa}=${x.atual}`).join(', ') || 'nenhuma'} — `
      + (s.reiniciadas ? 'RECOMEÇA (--reiniciar-sequencias-de-etiqueta)' : 'fica (etiqueta impressa pode estar em uso; para recomeçar: --reiniciar-sequencias-de-etiqueta)'),
  );
  l.push('  - credenciais, cofre de chaves e rastro da homologação do Asaas: FICAM SEMPRE (nenhuma flag tira).');
  l.push('');
  l.push(`Ficam (${plano.preservadas.length} tabela(s) com linhas):`);
  l.push(`  ${plano.preservadas.map((p) => `${p.tabela} ${p.linhas}`).join(', ')}`);
  l.push('');
  l.push(`Fotos que vão para a quarentena depois do COMMIT: ${plano.arquivos.length}${plano.arquivos.length ? ` (${plano.arquivos.map((a) => `${a.pasta}/${a.nome}`).join(', ')})` : ''}`);
  l.push(`Documentos fiscais de PRODUÇÃO: ${plano.documentosFiscaisDeProducao}`);
  l.push(`Bloqueios: ${plano.bloqueios.length === 0 ? 'nenhum' : ''}`);
  for (const b of plano.bloqueios) l.push(`  - ${b}`);
  l.push('');
  l.push(`Impressão digital: ${plano.impressao}`);
  if (plano.bloqueios.length === 0) {
    const banco = bancoExplicito ? ` --banco "${caminho}"` : '';
    const flags = flagsDe(plano.opcoes).map((x) => ` ${x}`).join('');
    l.push('Para aplicar — com a API PARADA (node server/dist/scripts/parar-api.js):');
    l.push(`  ${COMANDO} --aplicar ${plano.impressao}${banco}${flags}`);
    l.push(`  (no servidor: ${COMANDO_NO_SERVIDOR} --aplicar ${plano.impressao}${banco}${flags})`);
  }
  return l;
}

function avisosDaSubida(): string[] {
  const avisos: string[] = [];
  if (!process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD?.trim()) {
    avisos.push(
      'AVISO: DEVORA_BOOTSTRAP_ADMIN_PASSWORD não está no ambiente. Depois da limpeza não sobra conta nenhuma: '
        + 'ninguém entra até a próxima subida da API COM a variável definida no .env — é essa subida que cria o `admin` '
        + '(senha provisória). Defina, suba, entre como admin, troque a senha e apague a variável.',
    );
  } else {
    avisos.push(
      'DEVORA_BOOTSTRAP_ADMIN_PASSWORD está definida: a próxima subida da API cria o `admin` com ela (provisória). '
        + 'Entre, troque a senha e apague a variável do .env.',
    );
  }
  // O acesso rápido foi removido e as variáveis dele, aposentadas (ver
  // config/acessoSemSenhaAposentado.ts): ligada em produção, a API não sobe.
  const aposentadasLigadas = VARIAVEIS_DO_ACESSO_SEM_SENHA.filter((v) => valorLigado(process.env[v]));
  if (aposentadasLigadas.length > 0) {
    avisos.push(
      `AVISO: variável aposentada do acesso sem senha ligada neste ambiente (${aposentadasLigadas.join(', ')}). `
        + 'Apague do .env antes de subir sobre o banco limpo: o acesso rápido não existe mais, e em produção a API '
        + 'se recusa a subir com ela ligada.',
    );
  }
  avisos.push(
    'Nos computadores de caixa, limpe os dados do site no navegador: a fila offline e a espera F7 do PDV moram lá, não no banco.',
  );
  return avisos;
}

function nadaAFazer(plano: Plano): string | null {
  if (plano.jaAplicadaEm) {
    return (
      `A limpeza da demonstração já foi aplicada neste banco em ${plano.jaAplicadaEm} (auditoria `
      + '`implantacao.limpeza_demonstracao`). Nada a fazer: o que o banco tem agora é dado da operação, e este comando não toca nele.'
    );
  }
  if (plano.totalQueSai === 0 && plano.bloqueios.length === 0) return 'Nada a fazer: não há dado de demonstração neste banco.';
  return null;
}

// ---------------------------------------------------------------------------

/** Simulação: abre só leitura, não escreve nada. */
export function simularLimpezaDaDemonstracao(
  opcoes: OpcoesDaLimpeza = {},
  bancoExplicito = false,
): ResultadoDoComando {
  const caminho = resolveDatabasePath();
  if (caminho === ':memory:' || !existsSync(caminho)) {
    return { codigo: 1, linhas: [], recusa: [`O arquivo do banco não existe: ${caminho}`] };
  }
  const db = new DatabaseSync(caminho, { readOnly: true });
  try {
    const plano = planejarLimpeza(db, opcoes);
    const linhas = ['=== LIMPEZA DA DEMONSTRAÇÃO — SIMULAÇÃO (nada foi escrito) ==='];
    const nada = nadaAFazer(plano);
    if (nada) {
      linhas.push(`Banco: ${caminho}`, nada);
      return { codigo: 0, linhas, recusa: [], plano };
    }
    const dono = donoRegistrado(db);
    if (dono) linhas.push(`Dono do banco agora: ${dono}. A aplicação recusa enquanto ele estiver no ar.`);
    linhas.push(...descreverPlano(plano, caminho, bancoExplicito));
    linhas.push('', ...avisosDaSubida());
    if (plano.bloqueios.length > 0) {
      return { codigo: 1, linhas, recusa: ['A limpeza NÃO pode ser aplicada sobre este banco: veja os bloqueios acima.'], plano };
    }
    return { codigo: 0, linhas, recusa: [], plano };
  } finally {
    db.close();
  }
}

function donoRegistrado(db: DatabaseSync): string | null {
  try {
    const l = db.prepare("SELECT tipo, pid, host, batida_em FROM core_instancia WHERE papel = 'dono'").get() as
      | { tipo: string; pid: number; host: string; batida_em: string }
      | undefined;
    return l ? `${l.tipo}, pid ${l.pid} em ${l.host}, última batida ${l.batida_em}` : null;
  } catch {
    return null; // banco de versão anterior: a tabela da trava ainda não existe
  }
}

function pastaDe(pasta: PastaDeArquivo): string {
  if (pasta === 'produtos') return uploadsDir();
  if (pasta === 'os') return photosDir();
  return equipmentPhotosDir();
}

/** Move (não apaga) os arquivos para a quarentena. Arquivo ausente só é contado. */
function quarentenar(arquivos: Plano['arquivos'], agora: Date): { pasta: string | null; movidos: number; ausentes: number } {
  if (arquivos.length === 0) return { pasta: null, movidos: 0, ausentes: 0 };
  const raizDosUploads = dirname(uploadsDir());
  const pasta = join(dirname(raizDosUploads), 'quarentena', `${carimbo(agora)}-limpeza-demonstracao`);
  let movidos = 0;
  let ausentes = 0;
  for (const a of arquivos) {
    const origem = join(pastaDe(a.pasta), basename(a.nome));
    if (!existsSync(origem)) {
      ausentes += 1;
      continue;
    }
    const destino = join(pasta, a.pasta, basename(a.nome));
    mkdirSync(dirname(destino), { recursive: true });
    try {
      renameSync(origem, destino);
    } catch {
      // Outro disco: copia e só então tira o original.
      copyFileSync(origem, destino);
      unlinkSync(origem);
    }
    movidos += 1;
  }
  return { pasta, movidos, ausentes };
}

/** Aplicação: com a impressão da simulação, e só com a API parada. */
export function aplicarLimpezaDaDemonstracao(
  impressao: string,
  opcoes: OpcoesDaLimpeza = {},
  agora: () => Date = () => new Date(),
): ResultadoDoComando {
  const caminho = resolveDatabasePath();
  const linhas = ['=== LIMPEZA DA DEMONSTRAÇÃO — APLICAÇÃO ===', `Banco: ${caminho}`];
  if (caminho === ':memory:' || !existsSync(caminho)) {
    return { codigo: 1, linhas, recusa: [`O arquivo do banco não existe: ${caminho}`] };
  }
  if (!/^[0-9a-f]{64}$/.test(impressao)) {
    return {
      codigo: 1,
      linhas,
      recusa: ['--aplicar pede a impressão digital da simulação (64 caracteres hexadecimais). Rode a simulação primeiro.'],
    };
  }

  let trava: Trava | null = null;
  try {
    try {
      trava = assumirInstanciaAgora('manutencao');
    } catch (err) {
      if (!(err instanceof BancoOcupado)) throw err;
      return { codigo: 1, linhas, recusa: [err.message, 'Nada foi apagado: pare a API antes de limpar.'] };
    }

    const db = getConnection();
    const plano = planejarLimpeza(db, opcoes);
    const nada = nadaAFazer(plano);
    if (nada) return { codigo: 0, linhas: [...linhas, nada], recusa: [], plano };
    if (plano.documentosFiscaisDeProducao > 0) {
      return {
        codigo: 1,
        linhas,
        recusa: [
          `Há ${plano.documentosFiscaisDeProducao} documento(s) fiscal(is) de PRODUÇÃO neste banco. `
            + 'Nota de verdade não se apaga: a limpeza da demonstração recusa este banco. Nada foi apagado.',
        ],
        plano,
      };
    }
    if (plano.impressao !== impressao) {
      return { codigo: 1, linhas, recusa: [new ImpressaoDivergente(impressao, plano.impressao).message], plano };
    }
    if (plano.bloqueios.length > 0) {
      return { codigo: 1, linhas, recusa: ['Nada foi apagado. Bloqueios:', ...plano.bloqueios.map((b) => `  - ${b}`)], plano };
    }

    // A cópia ANTES — sem ela, nada é apagado.
    const quando = agora();
    const copia = join(backupDirectory(), `grupo-sampaio-${carimbo(quando)}-antes_da_limpeza.db`);
    try {
      copiarBancoParaArquivo(db, copia);
    } catch (err) {
      return { codigo: 1, linhas, recusa: [`Não foi possível copiar o banco antes: ${(err as Error).message}`, 'Nada foi apagado.'], plano };
    }
    const veredito = verificarBackup(copia);
    if (!veredito.ok) {
      return { codigo: 1, linhas, recusa: [`A cópia de segurança não passou no integrity_check: ${veredito.motivo}`, 'Nada foi apagado.'], plano };
    }
    linhas.push(`Cópia de segurança (integrity_check ok, ${veredito.tabelas} tabelas): ${copia}`);

    let resultado;
    try {
      resultado = executarLimpeza(db, opcoes, impressao, { copiaDeSeguranca: basename(copia) });
    } catch (err) {
      if (err instanceof ImpressaoDivergente || err instanceof LimpezaBloqueada || err instanceof DivergenciaNaLimpeza) {
        return { codigo: 1, linhas, recusa: [err.message, `A cópia de antes continua em ${copia}.`], plano, copia };
      }
      return {
        codigo: 1,
        linhas,
        recusa: [`A limpeza falhou e voltou atrás (ROLLBACK, nada mudou): ${(err as Error).message}`, `A cópia de antes continua em ${copia}.`],
        plano,
        copia,
      };
    }

    linhas.push(`COMMIT: saíram ${resultado.plano.totalQueSai} linha(s) de ${resultado.plano.porTabela.length} tabela(s), exatamente o plano.`);
    for (const t of resultado.plano.porTabela) linhas.push(`  ${t.tabela}: -${t.saem}`);

    const quarentena = quarentenar(resultado.plano.arquivos, quando);
    if (quarentena.pasta) {
      linhas.push(
        `Fotos movidas para a QUARENTENA (não apagadas): ${quarentena.movidos}`
          + `${quarentena.ausentes ? ` (${quarentena.ausentes} já não estavam no disco)` : ''} — ${quarentena.pasta}`,
      );
    } else {
      linhas.push('Fotos: nenhuma a mover.');
    }

    const p = provasDaLimpeza(db, resultado);
    linhas.push('', 'PROVAS (depois do COMMIT):');
    linhas.push(`  integrity_check: ${p.integridade}`);
    linhas.push(`  foreign_key_check: ${p.chavesQuebradas} referência(s) quebrada(s)`);
    linhas.push(`  produtos: ${p.produtos}`);
    linhas.push(`  saldo: ${p.saldo.linhas} linha(s), quantidade ${p.saldo.quantidade}, reservado ${p.saldo.reservado}`);
    linhas.push(`  movimentos de estoque: ${p.movimentos}`);
    linhas.push(`  contas da demonstração: ${p.usuariosDaDemonstracao} (contas no banco: ${p.usuarios})`);
    linhas.push(`  sessões de API: ${p.sessoes}`);
    linhas.push(`  empresas: ${p.empresas.depois} (antes: ${p.empresas.antes})`);
    for (const c of p.configuracao) linhas.push(`  ${c.tabela}: ${c.igual ? 'igual a antes' : 'DIFERENTE'}`);
    linhas.push(
      `  toda linha que devia ficar, em todas as tabelas: ${p.divergencias.length === 0 ? 'igual a antes' : `DIVERGE — ${p.divergencias.join(' ')}`}`,
    );
    linhas.push(
      `  auditoria: ${p.auditoria.antes} → ${p.auditoria.depois} (as de antes intactas; a nova `
        + `implantacao.limpeza_demonstracao ${p.auditoria.novaLinha ? 'gravada' : 'NÃO ACHADA'})`,
    );
    linhas.push(`  numeração que fica: ${p.sequenciasQueFicam.join(', ') || 'nenhuma'}`);
    linhas.push('', ...avisosDaSubida());

    const provasOk = p.integridade === 'ok' && p.chavesQuebradas === 0 && p.divergencias.length === 0
      && p.configuracao.every((c) => c.igual) && p.auditoria.novaLinha;
    return {
      codigo: provasOk ? 0 : 1,
      linhas,
      recusa: provasOk ? [] : [`Uma prova falhou depois do COMMIT: restaure a cópia ${copia} com npm run db:restore.`],
      plano: resultado.plano,
      copia,
      quarentena,
    };
  } finally {
    trava?.liberar();
  }
}
