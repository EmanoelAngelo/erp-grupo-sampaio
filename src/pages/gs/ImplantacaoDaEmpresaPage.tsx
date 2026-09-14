/**
 * Implantação de UMA empresa — o checklist inteiro numa tela (GAP-PRD-067).
 *
 * Antes, saber se a sexta operação estava pronta exigia percorrer umas oito
 * telas de domínio (Fiscal, Certificado, Impressoras, Prontidão online,
 * Logística, E-mails, Banco central, Asaas), trocando de empresa a cada uma.
 * Aqui o servidor junta tudo, item por item, no mesmo vocabulário:
 *
 *   DIVERGENTE              alguém confirmou e o dado mudou, ou o estado está errado;
 *   PENDENTE                falta algo que se resolve numa tela do sistema;
 *   AUTO-DETECTADO          o sistema achou o dado; falta alguém dizer que está certo;
 *   BLOQUEADO EXTERNAMENTE  depende de fora (certificado, SEFAZ, SMTP, hardware…);
 *   CONFIRMADO / PRONTO     conferido;
 *   N.A.                    não se aplica a esta empresa (por regra ou com motivo).
 *
 * Cada item diz QUEM resolve e leva à tela que resolve. "Confirmar" e "não se
 * aplica" ficam gravados com quem e quando — e a confirmação cai sozinha se o
 * dado mudar depois.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  desmarcarItemDaImplantacao,
  implantacaoDaEmpresa,
  marcarItemDaImplantacao,
  type DonoDoItem,
  type EstadoDeImplantacao,
  type ImplantacaoDaEmpresa,
  type ItemDeImplantacao,
} from '@/lib/api/implantacaoDasEmpresas';
import { dataHoraBR } from '@/lib/datas';
import { ESTADO_NA_TELA, SITUACAO_NA_TELA } from '@/pages/gs/implantacaoRotulos';

const QUEM: Record<DonoDoItem, string> = {
  gestor: 'quem opera a empresa',
  dono: 'o dono do sistema',
  contador: 'o contador',
  sefaz: 'a SEFAZ',
  externo: 'fornecedor externo',
};

const ORDEM_DO_RESUMO: EstadoDeImplantacao[] = [
  'DIVERGENTE',
  'PENDENTE',
  'AUTO_DETECTADO',
  'BLOQUEADO_EXTERNAMENTE',
  'CONFIRMADO',
  'PRONTO',
  'NAO_APLICAVEL',
];

export default function ImplantacaoDaEmpresaPage() {
  const { companyId = '' } = useParams<{ companyId: string }>();
  const [dados, setDados] = useState<ImplantacaoDaEmpresa | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [dispensando, setDispensando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setDados(await implantacaoDaEmpresa(companyId));
      setErro(null);
    } catch (err) {
      setErro(
        err instanceof ApiRequestError && err.status === 403
          ? 'Só quem responde por esta empresa (administrador ou gestor com vínculo nela) vê a implantação dela.'
          : err instanceof ApiRequestError
            ? err.message
            : 'Falha ao ler a implantação da empresa.',
      );
    } finally {
      setCarregando(false);
    }
  }, [companyId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const agir = async (item: ItemDeImplantacao, acao: () => Promise<unknown>) => {
    setOcupado(item.chave);
    try {
      await acao();
      setDispensando(null);
      setMotivo('');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao gravar a marca do item.');
    } finally {
      setOcupado(null);
    }
  };

  const nome = dados?.empresa.nome ?? 'Empresa';

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Empresas do grupo', nome]}
        title={`Implantação — ${nome}`}
        subtitle="Tudo o que esta empresa precisa para operar, item por item, com a tela que resolve e quem resolve."
        actions={
          <div className="flex gap-2">
            <Link
              to="/sistema/empresas"
              className="inline-flex items-center h-10 px-3 text-[length:var(--gs-text-sm)] text-[var(--gs-purple-900)] underline"
            >
              Voltar às empresas
            </Link>
            <Button variant="secondary" onClick={() => void carregar()} disabled={carregando}>
              {carregando ? 'Conferindo…' : 'Conferir de novo'}
            </Button>
          </div>
        }
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      {dados && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <Badge tone={SITUACAO_NA_TELA[dados.situacao].tom}>{SITUACAO_NA_TELA[dados.situacao].rotulo}</Badge>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]" data-testid="resumo">
                {ORDEM_DO_RESUMO.filter((e) => dados.resumo[e] > 0)
                  .map((e) => `${dados.resumo[e]} ${ESTADO_NA_TELA[e].rotulo.toLowerCase()}`)
                  .join(' · ')}
              </span>
            </div>
            <p className="m-0 text-[length:var(--gs-text-sm)]">{SITUACAO_NA_TELA[dados.situacao].frase}</p>
            <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {dados.empresa.razaoSocial} · conferido em {dataHoraBR(dados.avaliadoEm)}. Os itens marcados
              “do grupo” valem para todas as empresas.
            </p>
          </Card>

          {dados.areas.map((area) => (
            <section key={area.area} className="mt-5" aria-label={area.titulo}>
              <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] mt-0 mb-3">
                {area.titulo}
              </h2>
              <ul className="list-none p-0 m-0 grid gap-3">
                {area.itens.map((item) => (
                  <li key={item.chave} data-testid={`item-${item.chave}`}>
                    <Card>
                      <div className="flex flex-wrap items-center gap-3 mb-1">
                        <Badge tone={ESTADO_NA_TELA[item.estado].tom}>{ESTADO_NA_TELA[item.estado].rotulo}</Badge>
                        <strong>{item.titulo}</strong>
                        {item.global && <Badge tone="neutral">do grupo</Badge>}
                      </div>
                      <p className="m-0 text-[length:var(--gs-text-sm)]">{item.detalhe}</p>
                      <p className="mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        Quem resolve: {QUEM[item.dono]}
                        {item.onde && (
                          <>
                            {' · '}
                            <Link to={item.onde} className="underline text-[var(--gs-purple-900)]">
                              Abrir a tela
                            </Link>
                          </>
                        )}
                      </p>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.podeConfirmar && item.estado !== 'CONFIRMADO' && (
                          <Button
                            variant="secondary"
                            disabled={ocupado === item.chave}
                            onClick={() =>
                              void agir(item, () => marcarItemDaImplantacao(companyId, item.chave, { tipo: 'CONFIRMADO' }))
                            }
                          >
                            Confirmar que está certo
                          </Button>
                        )}
                        {item.podeMarcarNaoAplicavel && item.estado !== 'NAO_APLICAVEL' && dispensando !== item.chave && (
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setDispensando(item.chave);
                              setMotivo('');
                            }}
                          >
                            Não se aplica a esta empresa
                          </Button>
                        )}
                        {item.marca && (
                          <Button
                            variant="ghost"
                            disabled={ocupado === item.chave}
                            onClick={() => void agir(item, () => desmarcarItemDaImplantacao(companyId, item.chave))}
                          >
                            {item.marca.tipo === 'CONFIRMADO' ? 'Desfazer a confirmação' : 'Voltar a valer'}
                          </Button>
                        )}
                      </div>

                      {dispensando === item.chave && (
                        <div className="mt-3 flex flex-col gap-2">
                          <label className="text-[length:var(--gs-text-sm)] font-semibold" htmlFor={`motivo-${item.chave}`}>
                            Por que não se aplica?
                          </label>
                          <textarea
                            id={`motivo-${item.chave}`}
                            value={motivo}
                            onChange={(e) => setMotivo(e.target.value)}
                            rows={2}
                            maxLength={300}
                            placeholder="Ex.: esta loja não vende online."
                            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                              bg-[var(--gs-surface)] text-[length:var(--gs-text-base)]"
                          />
                          <div className="flex gap-2">
                            <Button
                              disabled={motivo.trim().length < 5 || ocupado === item.chave}
                              onClick={() =>
                                void agir(item, () =>
                                  marcarItemDaImplantacao(companyId, item.chave, {
                                    tipo: 'NAO_APLICAVEL',
                                    motivo: motivo.trim(),
                                  }),
                                )
                              }
                            >
                              Gravar “não se aplica”
                            </Button>
                            <Button variant="ghost" onClick={() => setDispensando(null)}>
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      )}
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </AppShell>
  );
}
