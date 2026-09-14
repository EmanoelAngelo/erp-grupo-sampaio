/**
 * Fotos em lote — rodada 45.
 *
 * O dono fotografa a loja inteira de uma vez e exporta tudo no fim. Subir
 * foto navegando cadastro a cadastro é a visita que nunca acontece — por
 * isso o caminho é UM: nomear cada arquivo com o código de barras ou o
 * código interno do produto e soltar a pasta inteira aqui.
 *
 * A tela faz três coisas, nesta ordem:
 *   1. mostra O QUE FALTA fotografar (publicados sem foto — a mesma fonte
 *      da prontidão online);
 *   2. resolve os nomes no servidor e mostra o casamento ANTES de subir
 *      qualquer byte — arquivo sem produto não viaja;
 *   3. sobe foto a foto pela rota que sempre existiu (um único escritor de
 *      imagem), com relatório honesto no fim: enviadas, sem produto, falhas.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, DataTable, EmptyState, PageHeader } from '@/components/gs/ui';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { coreApi } from '@/lib/api/core';
import { normalizeImage } from '@/lib/image';

interface NomeResolvido {
  name: string;
  code: string;
  productId: string | null;
  productName: string | null;
  internalCode: string | null;
  temFoto: boolean;
}

interface ProntidaoRow {
  id: string;
  name: string;
  internalCode: string;
  publishOnline: boolean;
  blockers: string[];
  /** Sem foto virou aviso (GAP-PRD-207); servidor antigo a mandava em `blockers`. */
  warnings?: string[];
}

type SituacaoEnvio = 'aguardando' | 'enviando' | 'enviada' | 'falhou';

export default function FotosEmLotePage() {
  const fileRef = useRef<HTMLInputElement>(null);
  /** Os arquivos escolhidos, indexados pelo nome — o envio precisa do File. */
  const [arquivos, setArquivos] = useState<Map<string, File>>(new Map());
  const [resolvidos, setResolvidos] = useState<NomeResolvido[]>([]);
  const [situacao, setSituacao] = useState<Record<string, SituacaoEnvio>>({});
  const [ocupado, setOcupado] = useState(false);
  const [mensagem, setMensagem] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(
    null,
  );
  /** Publicados ainda sem foto — a lista do que falta fotografar. */
  const [semFoto, setSemFoto] = useState<ProntidaoRow[]>([]);
  /** Erro é erro: sem a medida, a tela NÃO afirma "tudo fotografado". */
  const [semFotoErro, setSemFotoErro] = useState(false);

  const carregarSemFoto = useCallback(async () => {
    try {
      const r = await apiRequest<{ items: ProntidaoRow[] }>('/core/products/prontidao-online');
      setSemFoto(
        r.items.filter(
          (i) =>
            i.publishOnline
            && ((i.warnings ?? []).includes('sem_foto') || i.blockers.includes('sem_foto')),
        ),
      );
      setSemFotoErro(false);
    } catch {
      /*
        A REVISÃO MORDEU AQUI: o catch dizia "tudo fotografado" — erro
        exibido como sucesso. Sem a medida, a tela diz que não mediu.
      */
      setSemFoto([]);
      setSemFotoErro(true);
    }
  }, []);

  useEffect(() => {
    void carregarSemFoto();
  }, [carregarSemFoto]);

  /** Escolheu os arquivos → o servidor casa os nomes ANTES de subir qualquer byte. */
  const onArquivos = async (lista: FileList | null) => {
    if (!lista || lista.length === 0) return;
    const mapa = new Map<string, File>();
    for (const f of Array.from(lista)) mapa.set(f.name, f);
    setArquivos(mapa);
    setSituacao({});
    setMensagem(null);
    setOcupado(true);
    try {
      const r = await apiRequest<{ items: NomeResolvido[] }>(
        '/core/products/fotos-em-lote/resolver',
        { method: 'POST', body: { names: Array.from(mapa.keys()) } },
      );
      setResolvidos(r.items);
      const casados = r.items.filter((i) => i.productId).length;
      setMensagem({
        tone: casados === r.items.length ? 'ok' : 'info',
        text: `${casados} de ${r.items.length} arquivo(s) casaram com produtos. ${
          casados < r.items.length
            ? 'Os demais não sobem — confira o nome (código de barras ou código interno).'
            : ''
        }`,
      });
    } catch (err) {
      setResolvidos([]);
      setMensagem({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao resolver os nomes.',
      });
    } finally {
      setOcupado(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** Sobe cada foto casada pela rota de sempre — e conta o que aconteceu. */
  const enviar = async () => {
    setOcupado(true);
    setMensagem(null);
    let enviadas = 0;
    let falhas = 0;
    for (const item of resolvidos) {
      if (!item.productId) continue;
      /*
        A REVISÃO MORDEU AQUI: o reenvio subia TUDO de novo — o retry após
        uma falha duplicava a foto dos que já tinham subido. Enviada não
        viaja duas vezes; o segundo clique é o retry SÓ das pendentes.
      */
      if (situacao[item.name] === 'enviada') continue;
      const file = arquivos.get(item.name);
      if (!file) continue;
      setSituacao((s) => ({ ...s, [item.name]: 'enviando' }));
      try {
        const normalizada = await normalizeImage(file);
        await coreApi.addProductImage(item.productId, {
          dataUrl: normalizada.dataUrl,
          fileName: item.name,
          mimeType: normalizada.mimeType,
        });
        enviadas += 1;
        setSituacao((s) => ({ ...s, [item.name]: 'enviada' }));
      } catch {
        falhas += 1;
        setSituacao((s) => ({ ...s, [item.name]: 'falhou' }));
      }
    }
    const semProduto = resolvidos.filter((i) => !i.productId).length;
    setMensagem({
      tone: falhas > 0 ? 'error' : 'ok',
      text: `${enviadas} foto(s) enviada(s)${
        semProduto > 0 ? `, ${semProduto} sem produto (não subiram)` : ''
      }${falhas > 0 ? `, ${falhas} falha(s)` : ''}.`,
    });
    setOcupado(false);
    await carregarSemFoto();
  };

  const casados = resolvidos.filter((i) => i.productId).length;
  /** O botão conta o que AINDA falta subir — zero pendentes desarma. */
  const pendentes = resolvidos.filter(
    (i) => i.productId && situacao[i.name] !== 'enviada',
  ).length;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['E-commerce', 'Fotos em lote']}
        title="Fotos em lote"
        subtitle="Nomeie cada arquivo com o código de barras ou o código interno do produto (ex.: 7891234567895.jpg) e solte tudo de uma vez."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              aria-label="Arquivos de foto"
              onChange={(e) => void onArquivos(e.target.files)}
            />
            <Button onClick={() => fileRef.current?.click()} loading={ocupado}>
              Escolher fotos
            </Button>
          </>
        }
      />

      {mensagem && (
        <p
          role={mensagem.tone === 'error' ? 'alert' : 'status'}
          className={`m-0 mb-4 px-4 py-3 rounded-[var(--gs-radius)] text-[length:var(--gs-text-sm)] ${
            mensagem.tone === 'error'
              ? 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
              : 'bg-[var(--gs-surface-hover)]'
          }`}
        >
          {mensagem.text}
        </p>
      )}

      {resolvidos.length > 0 && (
        <Card
          title="Conferência do lote"
          subtitle="Nada sobe antes de você ver o casamento. Arquivo sem produto não viaja."
          className="mb-5"
          padded={false}
          actions={
            <Button
              variant="success"
              onClick={() => void enviar()}
              loading={ocupado}
              disabled={pendentes === 0}
            >
              Enviar {pendentes} foto(s)
            </Button>
          }
        >
          <DataTable
            columns={[
              { header: 'Arquivo', render: (r: NomeResolvido) => r.name },
              {
                header: 'Produto',
                render: (r: NomeResolvido) =>
                  r.productId ? (
                    <span className="inline-flex flex-col">
                      <span>{r.productName}</span>
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] font-mono">
                        {r.internalCode}
                      </span>
                    </span>
                  ) : (
                    <Badge tone="warning">sem produto com o código "{r.code}"</Badge>
                  ),
              },
              {
                header: 'Situação',
                render: (r: NomeResolvido) => {
                  const s = situacao[r.name];
                  if (s === 'enviada') return <Badge tone="success">Enviada</Badge>;
                  if (s === 'falhou') return <Badge tone="danger">Falhou</Badge>;
                  if (s === 'enviando') return <Badge tone="info">Enviando…</Badge>;
                  if (!r.productId) return <span className="text-[var(--gs-muted)]">—</span>;
                  return r.temFoto ? (
                    // Acrescentar não é estrear: quem já tem foto ganha mais uma.
                    <Badge tone="info">Já tem foto — será acrescentada</Badge>
                  ) : (
                    <Badge tone="neutral">Primeira foto</Badge>
                  );
                },
              },
            ]}
            rows={resolvidos}
            keyOf={(r) => r.name}
            empty={<EmptyState title="Nenhum arquivo" description="Escolha as fotos acima." />}
          />
        </Card>
      )}

      <Card
        title="O que ainda falta fotografar"
        subtitle="Produtos publicados na loja que estão sem foto — a vitrine mostra o card sem imagem."
        padded={false}
      >
        <DataTable
          columns={[
            { header: 'Produto', render: (r: ProntidaoRow) => r.name },
            {
              header: 'Código',
              render: (r: ProntidaoRow) => (
                <span className="font-mono text-[length:var(--gs-text-sm)]">{r.internalCode}</span>
              ),
            },
          ]}
          rows={semFoto}
          keyOf={(r) => r.id}
          empty={
            semFotoErro ? (
              <EmptyState
                title="Não foi possível medir"
                description="A lista de produtos sem foto não carregou — recarregue a página."
              />
            ) : (
              <EmptyState
                title="Tudo fotografado"
                description="Nenhum produto publicado está sem foto."
              />
            )
          }
        />
      </Card>
    </AppShell>
  );
}
