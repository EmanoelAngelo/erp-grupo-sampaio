/**
 * ============================================================================
 * O PASSO 86 — o vínculo de hoje ganha escopo de caixa e de bancada
 * ============================================================================
 *
 * RBAC granular, F1 (desenho §3.2 e §7.2, com a D3b). O passo é o único
 * trabalho de DADO da F1; as tabelas e as colunas vêm da DDL canônica.
 *
 * `core_user_companies` ganha cinco colunas — `all_terminals`, `all_workshops`,
 * `access_version`, `updated_at`, `updated_by` —, todas com DEFAULT ou
 * anuláveis. O passo as acrescenta ele mesmo (antes do `reconcileCoreSchema`
 * do fim da transação, que viria tarde demais para o UPDATE) e grava, em cada
 * vínculo que ainda não tem escolha (`all_workshops IS NULL`), o que ele vê HOJE:
 *
 *   - `admin_geral`, `gestor` e `gerente_oficina` → todas as bancadas (é o
 *     `isManager` de `resolveWorkshop`/`resolveWorkshopScope`);
 *   - membro de alguma bancada ATIVA da empresa → só as suas;
 *   - o MECÂNICO sem bancada ativa → nenhuma (D3b — o fallback dele era
 *     acidente: o mecânico nasce com bancada obrigatória);
 *   - os demais (não membros) → todas (o fallback de hoje, e a régua de
 *     empresa do balcão da oficina).
 *
 * Só bancada ATIVA conta, porque `listWorkshopsOf` só enxerga as ativas: quem
 * é membro só de bancada desativada vê hoje como quem não é membro.
 *
 * `all_terminals = 1` (qualquer caixa, como hoje) é o DEFAULT da coluna; nada a
 * gravar. Uma linha `access.migrated` por empresa vai para a trilha, com as
 * contagens.
 *
 * Idempotente: só toca vínculo sem escolha, e a escolha que o dono fizer
 * depois sobrevive às subidas seguintes.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const QUEM_VE_TODAS_HOJE = new Set(['admin_geral', 'gestor', 'gerente_oficina']);

export interface ResultadoDoPasso86 {
  vinculos: number;
  empresas: number;
}

interface Contagem {
  vinculos: number;
  todosOsCaixas: number;
  todasAsBancadas: number;
  soAsBancadasDeQueEMembro: number;
  nenhumaBancada: number;
}

export function aplicarPasso86(
  db: DatabaseSync,
  ferramentas: { addColumn: (tabela: string, coluna: string, ddl: string) => void },
): ResultadoDoPasso86 {
  ferramentas.addColumn('core_user_companies', 'all_terminals', 'INTEGER NOT NULL DEFAULT 1');
  ferramentas.addColumn('core_user_companies', 'all_workshops', 'INTEGER');
  ferramentas.addColumn('core_user_companies', 'access_version', 'INTEGER NOT NULL DEFAULT 1');
  ferramentas.addColumn('core_user_companies', 'updated_at', 'TEXT');
  ferramentas.addColumn('core_user_companies', 'updated_by', 'TEXT');

  const vinculos = db
    .prepare(
      `SELECT uc.id, uc.company_id, uc.profile_code, uc.all_terminals,
              EXISTS (
                SELECT 1 FROM core_workshop_members m
                  JOIN core_workshops w ON w.id = m.workshop_id
                 WHERE m.user_id = uc.user_id AND w.company_id = uc.company_id AND w.active = 1
              ) AS membro_de_bancada_ativa
         FROM core_user_companies uc
        WHERE uc.all_workshops IS NULL
        ORDER BY uc.company_id, uc.id`,
    )
    .all() as unknown as { id: string; company_id: string; profile_code: string; all_terminals: number; membro_de_bancada_ativa: number }[];

  const gravar = db.prepare('UPDATE core_user_companies SET all_workshops = ? WHERE id = ?');
  const porEmpresa = new Map<string, Contagem>();
  for (const v of vinculos) {
    const membro = v.membro_de_bancada_ativa === 1;
    const todas = QUEM_VE_TODAS_HOJE.has(v.profile_code) || (!membro && v.profile_code !== 'mecanico');
    gravar.run(todas ? 1 : 0, v.id);
    const c = porEmpresa.get(v.company_id) ?? {
      vinculos: 0, todosOsCaixas: 0, todasAsBancadas: 0, soAsBancadasDeQueEMembro: 0, nenhumaBancada: 0,
    };
    c.vinculos += 1;
    if (v.all_terminals !== 0) c.todosOsCaixas += 1;
    if (todas) c.todasAsBancadas += 1;
    else if (membro) c.soAsBancadasDeQueEMembro += 1;
    else c.nenhumaBancada += 1;
    porEmpresa.set(v.company_id, c);
  }

  const trilha = db.prepare(
    `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
     VALUES (?, ?, NULL, 'access.migrated', 'company', ?, ?, NULL, ?)`,
  );
  const agora = new Date().toISOString();
  for (const [empresa, c] of porEmpresa) {
    trilha.run(randomUUID(), empresa, empresa, JSON.stringify({ passo: 86, ...c }), agora);
  }
  return { vinculos: vinculos.length, empresas: porEmpresa.size };
}
