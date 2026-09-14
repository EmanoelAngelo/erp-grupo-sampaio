/**
 * O que falta para cada produto vender online.
 *
 * POR QUE ESTA TELA EXISTE
 *
 * "Publicar tudo" não é um botão possível. Nos produtos reais desta base,
 * NENHUM tinha foto e NENHUM tinha peso e dimensões. Sem medidas o frete não
 * consegue cotar e só a retirada fica disponível; sem foto a vitrine mostra
 * "Foto em breve" — vende, mas vende pior.
 *
 * Foto, peso, medida, preço e saldo são dados do DONO. O sistema não inventa
 * nenhum deles. O que ele pode fazer, e é o que esta tela faz, é dizer
 * exatamente o que falta em cada produto — transformando um "por que só cinco
 * itens aparecem na loja?" numa lista de tarefas.
 *
 * IMPEDIMENTO × AVISO (GAP-PRD-207). A foto era chamada de impedimento aqui
 * enquanto o cadastro publicava sem ela e a vitrine a mostrava: duas verdades.
 * Agora sem foto é AVISO — o produto publicado sem foto conta como vendendo —
 * e a publicação em massa só leva os sem foto quando o gestor aperta o botão
 * que diz isso com todas as letras.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, DataTable, EmptyState, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError, apiRequest } from '@/lib/api/client';

type Blocker =
  | 'sem_preco'
  | 'sem_foto'
  | 'sem_medidas'
  | 'sem_saldo'
  | 'nao_publicado'
  | 'inativo'
  | 'modelo_com_grade';

/** O que falta sem impedir a venda. */
type Aviso = 'sem_foto';

interface Linha {
  id: string;
  name: string;
  internalCode: string;
  priceCents: number;
  publishOnline: boolean;
  blockers: Blocker[];
  /** Ausente em servidor anterior à regra do aviso. */
  warnings?: Aviso[];
  ready: boolean;
  readyToPublish: boolean;
}

/**
 * O rótulo diz O QUE FAZER, não o nome do campo vazio.
 *
 * "sem_medidas" não ajuda ninguém; "pesar e medir" é uma tarefa que a pessoa
 * consegue executar hoje à tarde.
 */
const O_QUE_FAZER: Record<Blocker, { curto: string; comoResolver: string }> = {
  sem_preco: { curto: 'Sem preço', comoResolver: 'Defina o preço de venda no cadastro.' },
  sem_foto: {
    curto: 'Sem foto',
    comoResolver:
      'Fotografe o produto e envie a imagem no cadastro. Sem foto ele aparece na vitrine como '
      + '"Foto em breve" — vende, mas vende pior.',
  },
  sem_medidas: {
    curto: 'Sem medidas',
    comoResolver:
      'Pese e meça a embalagem (peso em gramas, dimensões em centímetros). Sem isso o frete '
      + 'não pode ser calculado e só a retirada fica disponível.',
  },
  sem_saldo: { curto: 'Sem saldo', comoResolver: 'Dê entrada no estoque antes de publicar.' },
  nao_publicado: { curto: 'Não publicado', comoResolver: 'Marque para publicar na loja online.' },
  inativo: { curto: 'Inativo', comoResolver: 'Reative o produto no cadastro.' },
  modelo_com_grade: {
    curto: 'Modelo com grade',
    comoResolver: 'Quem vai para a vitrine são as variantes (tamanho/cor), não o modelo.',
  },
};

/** Os avisos da linha — servidor antigo mandava a foto entre os impedimentos. */
function avisosDe(l: Linha): Aviso[] {
  return l.warnings ?? (l.blockers.includes('sem_foto') ? ['sem_foto'] : []);
}

function semFoto(l: Linha): boolean {
  return avisosDe(l).includes('sem_foto');
}

export default function ProntidaoOnlinePage() {
  const [linhas, setLinhas] = useState<Linha[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await apiRequest<{ items: Linha[] }>('/core/products/prontidao-online');
      setLinhas(r.items);
      setErro(null);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os produtos.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const publicarProntos = async (incluirSemFoto: boolean) => {
    setOcupado(true);
    setMensagem(null);
    try {
      const r = await apiRequest<{ published: string[]; skipped: number; semFoto?: number }>(
        '/core/products/publicar-prontos',
        { method: 'POST', body: { incluirSemFoto } },
      );
      const esperando = r.semFoto
        ? ` ${r.semFoto} sem foto esperam a sua decisão.`
        : '';
      setMensagem(
        r.published.length === 0
          ? `Nenhum produto publicado. ${r.skipped} ainda têm pendências.${esperando}`
          : `${r.published.length} produto(s) publicado(s). ${r.skipped} continuam com pendência.${esperando}`,
      );
      await carregar();
    } catch (err) {
      setMensagem(err instanceof ApiRequestError ? err.message : 'Falha ao publicar.');
    } finally {
      setOcupado(false);
    }
  };

  const naLoja = linhas?.filter((l) => l.ready) ?? [];
  const prontosParaPublicar = linhas?.filter((l) => l.readyToPublish) ?? [];
  const completos = prontosParaPublicar.filter((l) => !semFoto(l));
  const prontosSemFoto = prontosParaPublicar.filter(semFoto);
  const comPendencia = linhas?.filter((l) => !l.ready && !l.readyToPublish) ?? [];

  /** Quantos produtos cada pendência atinge — mostra por onde começar. */
  const porPendencia = new Map<Blocker, number>();
  for (const l of linhas ?? []) {
    const itens = new Set<Blocker>([...l.blockers, ...avisosDe(l)]);
    for (const b of itens) porPendencia.set(b, (porPendencia.get(b) ?? 0) + 1);
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Produtos', 'Prontidão online']}
        title="O que falta para vender online"
        subtitle="Foto, preço, medidas e saldo são dados seus — o sistema não os inventa. Aqui está o que falta em cada produto."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void publicarProntos(false)}
              disabled={ocupado || completos.length === 0}
            >
              {ocupado ? 'Publicando…' : `Publicar ${completos.length} pronto(s)`}
            </Button>
            {prontosSemFoto.length > 0 && (
              <Button variant="secondary" onClick={() => void publicarProntos(true)} disabled={ocupado}>
                {`Publicar também ${prontosSemFoto.length} sem foto`}
              </Button>
            )}
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

      {mensagem && (
        <p role="status" className="mb-4 text-[length:var(--gs-text-sm)]">
          {mensagem}
        </p>
      )}

      {prontosSemFoto.length > 0 && (
        <p className="mb-4 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          {prontosSemFoto.length} produto(s) só não têm foto. Publicados assim, aparecem na
          vitrine como "Foto em breve" — é aviso, não bloqueio. A decisão de publicá-los sem foto
          é sua.
        </p>
      )}

      {linhas && (
        <>
          <div className="grid gap-4 md:grid-cols-3 mb-5">
            <Card>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] block">
                Vendendo na loja
              </span>
              <strong className="text-[length:var(--gs-text-2xl)]" data-testid="prontidao-na-loja">
                {naLoja.length}
              </strong>
              <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                de {linhas.length} produtos
              </span>
            </Card>
            <Card>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] block">
                Prontos, só falta publicar
              </span>
              <strong className="text-[length:var(--gs-text-2xl)] text-[var(--gs-success)]">
                {prontosParaPublicar.length}
              </strong>
            </Card>
            <Card>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] block">
                Com pendência
              </span>
              <strong className="text-[length:var(--gs-text-2xl)] text-[var(--gs-warning)]">
                {comPendencia.length}
              </strong>
            </Card>
          </div>

          {porPendencia.size > 0 && (
            <Card title="Por onde começar" className="mb-5">
              <ul className="list-none p-0 m-0 flex flex-col gap-3">
                {[...porPendencia.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([blocker, quantos]) => (
                    <li key={blocker} className="text-[length:var(--gs-text-sm)]">
                      <strong>
                        {O_QUE_FAZER[blocker].curto} — {quantos} produto(s)
                      </strong>
                      <span className="block text-[var(--gs-muted)]">
                        {O_QUE_FAZER[blocker].comoResolver}
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <Card padded={false}>
        <DataTable
          columns={[
            { header: 'Produto', render: (r: Linha) => r.name },
            { header: 'Código', render: (r: Linha) => r.internalCode },
            {
              header: 'Preço',
              align: 'right',
              render: (r: Linha) => (r.priceCents ? formatCents(r.priceCents) : '—'),
            },
            {
              header: 'Situação',
              render: (r: Linha) =>
                r.ready ? (
                  <Badge tone="success">Vendendo</Badge>
                ) : r.readyToPublish ? (
                  <Badge tone="info">Pronto para publicar</Badge>
                ) : (
                  <Badge tone="warning">Pendente</Badge>
                ),
            },
            {
              header: 'O que falta',
              render: (r: Linha) => {
                const impedimentos = r.blockers.filter((b) => b !== 'sem_foto');
                const avisos = avisosDe(r);
                if (impedimentos.length === 0 && avisos.length === 0) return '—';
                return (
                  <span className="flex flex-wrap gap-1">
                    {impedimentos.map((b) => (
                      <span
                        key={b}
                        title={O_QUE_FAZER[b].comoResolver}
                        className="px-2 py-0.5 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]
                          text-[length:var(--gs-text-xs)]"
                      >
                        {O_QUE_FAZER[b].curto}
                      </span>
                    ))}
                    {avisos.map((a) => (
                      <span
                        key={a}
                        title={O_QUE_FAZER[a].comoResolver}
                        className="px-2 py-0.5 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
                          text-[var(--gs-warning)] text-[length:var(--gs-text-xs)]"
                      >
                        {O_QUE_FAZER[a].curto} (aviso)
                      </span>
                    ))}
                  </span>
                );
              },
            },
          ]}
          rows={linhas ?? []}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title="Nenhum produto cadastrado"
              description="Cadastre produtos para vê-los aqui."
            />
          }
        />
      </Card>
    </AppShell>
  );
}
