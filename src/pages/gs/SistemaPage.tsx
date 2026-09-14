/**
 * Sistema — versão, banco, cofre e os últimos erros (GAP-PRD-064, GAP-PRD-057).
 *
 * Os documentos de operação mandavam o operador para "status", "saúde" e
 * "prontidão" em telas que nunca existiram, e para "capturar o correlationId"
 * que nenhuma tela mostrava. O roteador `/system` respondia sem ninguém
 * perguntar — parte dele com estado cravado.
 *
 * Esta tela junta o que é de verdade e global:
 *
 *   - a versão publicada e o banco: o número do NÚCLEO contra o alvo desta
 *     build (o mesmo do `db:status`), o Node e desde quando o processo está no ar;
 *   - a prontidão do núcleo e as chaves de produção desligadas, pelo nome;
 *   - o esquema contra um banco novo desta build (GAP-PRD-140): o que
 *     diverge, o que a subida reparou e o que ficou esperando decisão;
 *   - o cofre: o ESTADO de cada segredo (chave própria ou padrão, selado com a
 *     chave atual ou antiga), nunca o valor — antes esta rota não tinha tela;
 *   - os últimos erros desta aba, com o código que o log do servidor conhece.
 *
 * O que é por empresa está em Empresas do grupo › Implantação; a publicação,
 * em Implantação; a cópia do banco, em Backup.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, PageHeader } from '@/components/gs/ui';
import { ApiRequestError, ultimosErrosDaApi, type ErroDaApiRegistrado } from '@/lib/api/client';
import {
  prontidaoDoNucleo,
  prontidaoDosSegredos,
  versaoDoSistema,
  type DerivaDoEsquema,
  type EstadoDaChave,
  type EstadoDeCredencial,
  type EstadoDoFuso,
  type EstadoDoSegredo,
  type ProntidaoDoNucleo,
  type ProntidaoDosSegredos,
  type SituacaoDaDeriva,
  type SituacaoDoEsquema,
  type VersaoDoSistema,
} from '@/lib/api/sistema';
import { dataHoraBR } from '@/lib/datas';

type Tom = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

const ESQUEMA: Record<SituacaoDoEsquema, { rotulo: string; tom: Tom }> = {
  EM_DIA: { rotulo: 'EM DIA', tom: 'success' },
  ATRASADO: { rotulo: 'ATRASADO', tom: 'warning' },
  ADIANTADO: { rotulo: 'BANCO MAIS NOVO QUE O SISTEMA', tom: 'danger' },
  NUNCA_MIGRADO: { rotulo: 'NUNCA MIGRADO', tom: 'danger' },
  SEM_BANCO: { rotulo: 'SEM BANCO', tom: 'danger' },
};

const CHAVE: Record<EstadoDaChave, { rotulo: string; tom: Tom }> = {
  PRODUCTION_SAFE: { rotulo: 'própria', tom: 'success' },
  DEVELOPMENT_DEFAULT: { rotulo: 'padrão de desenvolvimento', tom: 'danger' },
  MISSING: { rotulo: 'ausente', tom: 'danger' },
};

const SELO: Record<EstadoDoSegredo, { rotulo: string; tom: Tom }> = {
  SEALED_CURRENT_KEY: { rotulo: 'guardado com a chave atual', tom: 'success' },
  LEGACY_KEY: { rotulo: 'guardado com chave antiga — não abre', tom: 'danger' },
  ABSENT: { rotulo: 'não cadastrado', tom: 'neutral' },
};

// O corte do dia no SQL (deslocamento fixo) contra o fuso oficial (GAP-PRD-145).
const FUSO: Record<EstadoDoFuso, { rotulo: string; tom: Tom }> = {
  FIXO_VALE: { rotulo: 'O DIA DA LOJA CONFERE', tom: 'success' },
  VAI_DIVERGIR: { rotulo: 'VAI DIVERGIR', tom: 'warning' },
  DIVERGE_AGORA: { rotulo: 'O DIA DA LOJA DIVERGE', tom: 'danger' },
};

// O banco contra um banco novo desta build (GAP-PRD-140).
const DERIVA: Record<SituacaoDaDeriva, { rotulo: string; tom: Tom }> = {
  IDENTICO: { rotulo: 'IDÊNTICO AO BANCO NOVO', tom: 'success' },
  DIVERGE: { rotulo: 'DIVERGE DO BANCO NOVO', tom: 'warning' },
  NAO_SE_APLICA: { rotulo: 'CONFERÊNCIA NÃO SE APLICA', tom: 'neutral' },
  NAO_CONFERIDO: { rotulo: 'NÃO CONFERIDO', tom: 'danger' },
};

function mensagemDe(err: unknown, padrao: string): string {
  return err instanceof ApiRequestError ? err.message : padrao;
}

function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <dt className="min-w-[14rem] text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">{rotulo}</dt>
      <dd className="m-0 text-[length:var(--gs-text-sm)]">{children}</dd>
    </div>
  );
}

function Credencial({ c }: { c: EstadoDeCredencial }) {
  return (
    <>
      <Badge tone={SELO[c.selo].tom}>{SELO[c.selo].rotulo}</Badge>
      {c.trocaNoProvedor === 'REQUIRED' && <Badge tone="warning">trocar no provedor</Badge>}
    </>
  );
}

/**
 * O esquema contra um banco novo (GAP-PRD-140): cada divergência pelo nome,
 * o que a última subida reparou e o que ficou esperando decisão, com o comando.
 */
function DerivaNaTela({ d }: { d: DerivaDoEsquema }) {
  const conferido = d.situacao === 'IDENTICO' || d.situacao === 'DIVERGE';
  const reparo = d.ultimoReparo;
  return (
    <div className="mt-3 grid gap-1" data-testid="deriva-do-esquema">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--gs-text-sm)]">
        <span className="font-semibold text-[var(--gs-text-soft)]">Esquema contra um banco novo</span>
        <Badge tone={DERIVA[d.situacao].tom}>{DERIVA[d.situacao].rotulo}</Badge>
        {conferido && (
          <span>
            {d.tabelasConferidas} tabelas e {d.indicesConferidos} índices conferidos
            {d.objetosAMais > 0 ? ` · ${d.objetosAMais} objeto(s) só neste banco, mantidos` : ''}
          </span>
        )}
      </div>
      {d.motivo && <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">{d.motivo}</p>}
      {d.divergencias.length > 0 && (
        <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)]">
          {d.divergencias.map((x) => (
            <li key={`${x.tipo}-${x.tabela}-${x.objeto}`}>{x.descricao}</li>
          ))}
          {d.totalDeDivergencias > d.divergencias.length && (
            <li>… e mais {d.totalDeDivergencias - d.divergencias.length}.</li>
          )}
        </ul>
      )}
      {reparo && reparo.pendentes.length > 0 && (
        <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]" data-testid="deriva-pendentes">
          {reparo.pendentes.map((p) => (
            <li key={p.objeto}>
              {p.objeto}: {p.motivo}
            </li>
          ))}
        </ul>
      )}
      {reparo && reparo.reparados.length > 0 && (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Último reparo em {dataHoraBR(reparo.em)} ({reparo.modo === 'boot' ? 'na subida da API' : 'pelo comando'}):{' '}
          {reparo.reparados.length} item(ns) reparado(s).
        </p>
      )}
      {d.comoResolver && (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]" data-testid="deriva-como-resolver">
          {d.comoResolver}
        </p>
      )}
    </div>
  );
}

export default function SistemaPage() {
  const [versao, setVersao] = useState<VersaoDoSistema | null>(null);
  const [prontidao, setProntidao] = useState<ProntidaoDoNucleo | null>(null);
  const [segredos, setSegredos] = useState<ProntidaoDosSegredos | null>(null);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [ultimos, setUltimos] = useState<ErroDaApiRegistrado[]>([]);
  const [carregando, setCarregando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    const novos: Record<string, string> = {};
    // Três leituras independentes: uma recusa não apaga as outras duas.
    await Promise.all([
      versaoDoSistema()
        .then(setVersao)
        .catch((err) => {
          novos.versao = mensagemDe(err, 'Falha ao ler a versão.');
        }),
      prontidaoDoNucleo()
        .then(setProntidao)
        .catch((err) => {
          novos.prontidao = mensagemDe(err, 'Falha ao ler a prontidão.');
        }),
      prontidaoDosSegredos()
        .then(setSegredos)
        .catch((err) => {
          novos.segredos = mensagemDe(err, 'Falha ao ler o estado do cofre.');
        }),
    ]);
    setErros(novos);
    setUltimos(ultimosErrosDaApi());
    setCarregando(false);
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const alerta = (chave: string) =>
    erros[chave] ? (
      <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
        {erros[chave]}
      </p>
    ) : null;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Sistema']}
        title="Sistema"
        subtitle="Versão publicada, banco, cofre e os últimos erros — o que vale para as seis empresas."
        actions={
          <Button variant="secondary" onClick={() => void carregar()} disabled={carregando}>
            {carregando ? 'Conferindo…' : 'Conferir de novo'}
          </Button>
        }
      />

      <div className="grid gap-5">
        <Card title="Versão e banco" subtitle="O número do banco é o do núcleo, contra o alvo desta build — o mesmo do db:status.">
          {alerta('versao')}
          {versao && (
            <dl className="m-0" data-testid="versao">
              <Linha rotulo="Sistema">
                {versao.release} · ambiente <strong>{versao.environment}</strong>
              </Linha>
              <Linha rotulo="Banco (núcleo)">
                <Badge tone={ESQUEMA[versao.databaseSituation].tom}>{ESQUEMA[versao.databaseSituation].rotulo}</Badge>
                versão {versao.databaseVersion ?? '—'} de {versao.databaseTargetVersion}
              </Linha>
              <Linha rotulo="Camada de documentos (herdada)">{versao.documentsVersion ?? '—'}</Linha>
              <Linha rotulo="Processo">
                Node {versao.processo.node} · {versao.processo.plataforma} · no ar desde{' '}
                {dataHoraBR(versao.processo.noArDesde)}
                {versao.processo.supervisionado ? ' · com supervisor' : ' · sem supervisor'}
              </Linha>
              <Linha rotulo="Instância">
                {versao.instancia ? (
                  <>
                    <Badge tone={versao.instancia.estaInstancia ? 'success' : 'danger'}>
                      {versao.instancia.estaInstancia ? 'ÚNICA NESTE BANCO' : 'O BANCO É DE OUTRO PROCESSO'}
                    </Badge>
                    pid {versao.instancia.pid} em {versao.instancia.host} · dona do banco desde{' '}
                    {dataHoraBR(versao.instancia.iniciadoEm)} · última batida {dataHoraBR(versao.instancia.batidaEm)}
                  </>
                ) : (
                  <Badge tone="warning">SEM TRAVA — o processo não subiu pelo boot oficial</Badge>
                )}
              </Linha>
              {versao.calendario && (
                <Linha rotulo="Relógio da loja">
                  <Badge tone={FUSO[versao.calendario.estado].tom}>{FUSO[versao.calendario.estado].rotulo}</Badge>
                  {versao.calendario.fuso} · consultas SQL cortam o dia com {versao.calendario.deslocamentoSqlHoras}h
                  fixas · conferido até {dataHoraBR(versao.calendario.conferidoAte)}
                  {versao.calendario.comoResolver && (
                    <span className="basis-full text-[var(--gs-danger)]" data-testid="fuso-como-resolver">
                      {versao.calendario.comoResolver}
                    </span>
                  )}
                </Linha>
              )}
            </dl>
          )}
        </Card>

        <Card
          title="Prontidão do núcleo"
          subtitle="O banco na versão da build e igual a um banco novo, e o que está desligado para produção neste servidor."
        >
          {alerta('prontidao')}
          {prontidao && (
            <div data-testid="prontidao">
              <Badge tone={prontidao.coreStatus === 'READY' ? 'success' : 'danger'}>
                {prontidao.coreStatus === 'READY' ? 'NÚCLEO PRONTO' : 'NÚCLEO NÃO PRONTO'}
              </Badge>
              {prontidao.criticalBlockers.length > 0 && (
                <ul className="mt-2 mb-0 pl-5 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                  {prontidao.criticalBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {prontidao.externalBlockers.length > 0 && (
                <ul className="mt-2 mb-0 pl-5 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {prontidao.externalBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {prontidao.schemaDrift && <DerivaNaTela d={prontidao.schemaDrift} />}
            </div>
          )}
        </Card>

        <Card title="Cofre e chaves" subtitle="O estado de cada segredo. Nenhum valor sai do servidor.">
          {alerta('segredos')}
          {segredos && (
            <dl className="m-0" data-testid="segredos">
              <Linha rotulo="Chave de cifra (DEVORA_ENCRYPTION_KEY)">
                <Badge tone={CHAVE[segredos.encryptionKey].tom}>{CHAVE[segredos.encryptionKey].rotulo}</Badge>
              </Linha>
              <Linha rotulo="Chave das sessões (DEVORA_JWT_SECRET)">
                <Badge tone={CHAVE[segredos.jwtSecret].tom}>{CHAVE[segredos.jwtSecret].rotulo}</Badge>
              </Linha>
              <Linha rotulo="Certificado A1">
                <Badge tone={SELO[segredos.a1Pfx].tom}>{SELO[segredos.a1Pfx].rotulo}</Badge>
              </Linha>
              <Linha rotulo="Senha do certificado">
                <Badge tone={SELO[segredos.a1Password].tom}>{SELO[segredos.a1Password].rotulo}</Badge>
              </Linha>
              <Linha rotulo="Asaas (sandbox)">
                <Credencial c={segredos.asaasSandbox} />
              </Linha>
              <Linha rotulo="Asaas (produção)">
                <Credencial c={segredos.asaasProduction} />
              </Linha>
              <Linha rotulo="Senha do e-mail">
                <Credencial c={segredos.email} />
              </Linha>
              <Linha rotulo="Guardados com chave antiga">{segredos.legadoPendente}</Linha>
              <Linha rotulo="Cofre rotacionado em">
                {segredos.cofreRotacionadoEm ? dataHoraBR(segredos.cofreRotacionadoEm) : 'nunca'}
              </Linha>
            </dl>
          )}
        </Card>

        <Card
          title="Últimos erros desta aba"
          subtitle="Informe o código ao suporte: é o requestId que o log do servidor grava junto do erro."
        >
          {ultimos.length === 0 ? (
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Nenhum erro do servidor desde que esta aba abriu.
            </p>
          ) : (
            <ul className="list-none p-0 m-0 grid gap-2" data-testid="ultimos-erros">
              {ultimos.map((e, i) => (
                <li key={`${e.em}-${i}`} className="text-[length:var(--gs-text-sm)]">
                  <strong>{dataHoraBR(e.em)}</strong> · {e.metodo} {e.caminho} · {e.status} {e.codigo} — {e.mensagem}
                  {e.requestId && (
                    <>
                      {' '}
                      · código <code className="select-all">{e.requestId}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Por empresa: <Link to="/sistema/empresas" className="underline">Empresas do grupo › Implantação</Link>. A
          publicação: <Link to="/sistema/configuracoes/implantacao" className="underline">Implantação</Link>. A cópia do
          banco: <Link to="/sistema/configuracoes/backup" className="underline">Backup</Link>. Quem fez o quê:{' '}
          <Link to="/sistema/relatorios/auditoria" className="underline">Auditoria</Link>.
        </p>
      </div>
    </AppShell>
  );
}
