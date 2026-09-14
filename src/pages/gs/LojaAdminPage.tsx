/**
 * E-commerce › Administração da loja.
 *
 * A vitrine mostrava só o nome fantasia e a contagem de produtos: as seis lojas
 * do grupo apareciam iguais na home, sem nada dizendo o que cada uma vende. E
 * não havia onde escrever isso.
 *
 * O QUE ESTA TELA NÃO FAZ: escolher o que a loja vende.
 *
 * Quem decide isso continua sendo o cadastro do produto, em Produtos ›
 * Prontidão online. Uma segunda lista aqui divergiria do cadastro no primeiro
 * produto despublicado, e a loja passaria a oferecer o que não se pode vender.
 * Por isso o DESTAQUE é um sinalizador no próprio produto, e só vale para quem
 * já está publicado.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { coreApi, type StorefrontAdminProduct, type StorefrontSettings } from '@/lib/api/core';
import { PoliticaDoCheckoutCard } from '@/components/gs/PoliticaDoCheckout';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Os tipos de negócio, como a tela os oferece.
 *
 * Espelha `StorefrontPresets.ts` do servidor — que é quem RECUSA o que não
 * está na lista. Duas cópias de uma lista fechada é o preço de o navegador
 * não importar código do servidor; a defesa é o servidor validar, para uma
 * tela desatualizada nunca gravar um arranjo que ela não sabe desenhar.
 */
const NOME_DO_TIPO: Record<string, string> = {
  variedades: 'Importadora de variedades',
  moda: 'Moda e vestuário',
  beleza: 'Beleza e maquiagem',
  veiculos: 'Veículos e acessórios',
};

const DICA_DO_TIPO: Record<string, string> = {
  variedades: 'Busca em destaque, departamentos e mais produtos por linha.',
  moda: 'Foto grande, poucas peças por linha e as categorias em vitrine.',
  beleza: 'Vitrine em destaque, cards compactos e categorias por cor.',
  veiculos: 'Um modelo por vez, com os acessórios logo abaixo.',
};

export default function LojaAdminPage() {
  /** Publicados sem foto — o aviso que leva ao envio em lote (rodada 45). */
  const [semFoto, setSemFoto] = useState(0);
  const [settings, setSettings] = useState<StorefrontSettings | null>(null);
  const [produtos, setProdutos] = useState<StorefrontAdminProduct[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const [headline, setHeadline] = useState('');
  const [descricao, setDescricao] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  /** Que negócio esta loja faz — arruma a vitrine inteira (rodada 56). */
  const [preset, setPreset] = useState('');
  /** Em quantas vezes a loja anuncia que vende. Vazio = não anuncia. */
  const [parcelas, setParcelas] = useState('');
  const [faixa, setFaixa] = useState('');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const res = await coreApi.getStorefrontSettings();
      setSettings(res.settings);
      setProdutos(res.products);
      setHeadline(res.settings.headline ?? '');
      setDescricao(res.settings.description ?? '');
      setWhatsapp(res.settings.whatsapp ?? '');
      setFaixa(res.settings.banner_text ?? '');
      setParcelas(
        res.settings.installments_max == null ? '' : String(res.settings.installments_max),
      );
      setPreset(res.preset ?? '');
    } catch (err) {
      setSettings(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a loja.');
    }
  }, []);

  useEffect(() => {
    apiRequest<{ items: { publishOnline: boolean; blockers: string[]; warnings?: string[] }[] }>(
      '/core/products/prontidao-online',
    )
      .then((r) =>
        // Sem foto virou aviso (GAP-PRD-207); servidor antigo a mandava em `blockers`.
        setSemFoto(
          r.items.filter(
            (i) =>
              i.publishOnline
              && ((i.warnings ?? []).includes('sem_foto') || i.blockers.includes('sem_foto')),
          ).length,
        ),
      )
      .catch(() => setSemFoto(0));
  }, []);
  useEffect(() => {
    void carregar();
  }, [carregar]);

  /**
   * Sobe logo ou capa como base64. O arquivo vira URL pública; a paleta da
   * marca é código aprovado pelo dono — o gestor controla a IMAGEM.
   */
  const enviarImagem = async (tipo: 'logo' | 'capa', file: File | null) => {
    if (!file) return;
    setOcupado(true);
    setErro(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('não deu para ler o arquivo'));
        r.readAsDataURL(file);
      });
      const s = await coreApi.setStoreImage(tipo, dataUrl);
      setSettings(s);
      setAviso(tipo === 'logo' ? 'Logo atualizado.' : 'Capa atualizada.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível enviar a imagem.');
    } finally {
      setOcupado(false);
    }
  };

  const removerImagem = async (tipo: 'logo' | 'capa') => {
    setOcupado(true);
    try {
      const s = await coreApi.removeStoreImage(tipo);
      setSettings(s);
      setAviso(tipo === 'logo' ? 'Logo removido.' : 'Capa removida.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível remover.');
    } finally {
      setOcupado(false);
    }
  };

  const salvar = async (extra: Record<string, unknown> = {}) => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      await coreApi.updateStorefrontSettings({
        headline,
        description: descricao,
        whatsapp,
        bannerText: faixa,
        installmentsMax: parcelas.trim() || null,
        storefrontPreset: preset || null,
        ...extra,
      });
      setAviso('Salvo. A loja já mostra assim.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setOcupado(false);
    }
  };

  const alternarDestaque = async (p: StorefrontAdminProduct) => {
    setErro(null);
    try {
      await coreApi.setFeatured(p.id, p.featured_online === 0);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao alterar o destaque.');
    }
  };

  const destaques = produtos.filter((p) => p.featured_online === 1);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['E-commerce', 'Administração']}
        title="Administração da loja"
        subtitle="A identidade da vitrine desta operação. O que a loja vende continua sendo decidido no cadastro do produto."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {semFoto > 0 && (
        <Card className="mb-5">
          <p className="m-0">
            <strong>{semFoto} produto(s) publicado(s) sem foto</strong> — a vitrine mostra o
            card sem imagem.{' '}
            <Link to="/sistema/loja/fotos" className="font-semibold">
              Enviar fotos em lote →
            </Link>
          </p>
        </Card>
      )}

      {settings && (
        <>
          <Card title="Como a loja se apresenta">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Chamada" hint="Uma linha dizendo o que esta loja vende">
                {(p) => (
                  <Input
                    {...p}
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value)}
                    placeholder="Moda feminina em Pelotas"
                  />
                )}
              </Field>
              <Field label="WhatsApp" hint="Aparece para o cliente falar com a loja">
                {(p) => (
                  <Input
                    {...p}
                    value={whatsapp}
                    onChange={(e) => setWhatsapp(e.target.value)}
                    placeholder="53999990000"
                  />
                )}
              </Field>
            </div>
            <Field label="Descrição">
              {(p) => (
                <Input
                  {...p}
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value)}
                  placeholder="Peças novas toda semana, entrega em Pelotas"
                />
              )}
            </Field>

            <div className="grid gap-4 md:grid-cols-2 mt-1">
              {/*
                O TIPO DE NEGÓCIO arruma a vitrine inteira (rodada 56): a
                densidade da grade, a proporção do card e se a busca abre a
                página. Antes desta rodada a única diferença entre as cinco
                lojas era a cor.

                A dica embaixo diz o que MUDA, e não só o nome do negócio —
                quatro palavras soltas fariam o dono escolher no chute.
              */}
              <Field
                label="Tipo de negócio"
                hint={
                  preset
                    ? DICA_DO_TIPO[preset] ?? 'Arranjo neutro.'
                    : 'Sem tipo, a vitrine usa um arranjo neutro.'
                }
              >
                {(p) => (
                  <select
                    {...p}
                    className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                      bg-[var(--gs-surface)] px-3 py-2 text-[length:var(--gs-text-sm)]"
                    value={preset}
                    onChange={(e) => setPreset(e.target.value)}
                  >
                    <option value="">Não declarado</option>
                    {Object.entries(NOME_DO_TIPO).map(([id, rotulo]) => (
                      <option key={id} value={id}>
                        {rotulo}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              {/*
                PARCELAMENTO É O QUE A LOJA ANUNCIA, e não a taxa que a
                operadora cobra dela — que já existe noutro cadastro. Em branco
                não aparece selo nenhum: "até 12x" sem regra é promessa que o
                caixa não honra.
              */}
              <Field
                label="Parcelamos em até"
                hint="De 1 a 24. Em branco, a vitrine não anuncia parcelamento."
              >
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    value={parcelas}
                    onChange={(e) => setParcelas(e.target.value)}
                    placeholder="6"
                  />
                )}
              </Field>
            </div>

            <Button onClick={() => void salvar()} loading={ocupado} className="mt-3">
              Salvar
            </Button>
          </Card>

          {/* Quem pode comprar: conta obrigatória (padrão) ou visitante — GAP-PRD-028. */}
          <PoliticaDoCheckoutCard />

          <Card
            title="Identidade da marca"
            subtitle="O logo aparece no cabeçalho da página da loja; a capa apresenta a loja no topo. A paleta de cores é combinada com o dono e vive no código."
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {(['logo', 'capa'] as const).map((tipo) => {
                const url = tipo === 'logo' ? settings.logo_url : settings.cover_url;
                return (
                  <div key={tipo} className="flex flex-col gap-2">
                    <p className="m-0 font-semibold text-[length:var(--gs-text-sm)]">
                      {tipo === 'logo' ? 'Logo' : 'Capa'}
                    </p>
                    {url ? (
                      <img
                        // A MESMA armadilha da vitrine: a imagem e servida
                        // pela API, noutra porta, e o Vite nao tem proxy.
                        // Sem o resolvedor, o gestor envia o logo, le
                        // "Logo atualizado." e ve moldura quebrada logo abaixo.
                        src={coreApi.imageUrl(url)}
                        alt={tipo === 'logo' ? 'Logo da loja' : 'Capa da loja'}
                        className={
                          tipo === 'logo'
                            ? 'h-20 w-20 object-cover rounded-full border border-[var(--gs-border)]'
                            : 'h-24 w-full object-cover rounded-[var(--gs-radius)] border border-[var(--gs-border)]'
                        }
                      />
                    ) : (
                      <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        Nenhuma imagem enviada.
                      </p>
                    )}
                    <label className="text-[length:var(--gs-text-sm)]">
                      <span className="sr-only">{tipo === 'logo' ? 'Enviar logo' : 'Enviar capa'}</span>
                      <input
                        type="file"
                        // SVG não entra (GAP-PRD-066): é documento e pode carregar script.
                        accept="image/png,image/jpeg,image/webp"
                        aria-label={tipo === 'logo' ? 'Enviar logo' : 'Enviar capa'}
                        onChange={(e) => void enviarImagem(tipo, e.target.files?.[0] ?? null)}
                      />
                    </label>
                    {url && (
                      <Button variant="ghost" loading={ocupado} onClick={() => void removerImagem(tipo)}>
                        Remover
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Faixa de aviso">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[280px]">
                <Field label="Texto da faixa" hint="Frete grátis, horário especial, feriado…">
                  {(p) => (
                    <Input {...p} value={faixa} onChange={(e) => setFaixa(e.target.value)} />
                  )}
                </Field>
              </div>
              <Badge tone={settings.banner_active ? 'success' : 'neutral'}>
                {settings.banner_active ? 'Aparecendo' : 'Desligada'}
              </Badge>
              <Button
                variant="ghost"
                loading={ocupado}
                onClick={() => void salvar({ bannerActive: settings.banner_active === 0 })}
              >
                {settings.banner_active ? 'Desligar' : 'Ligar'}
              </Button>
            </div>
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              O texto fica guardado mesmo desligado — escreva hoje e ligue no dia. Desligada, ela
              não chega ao cliente.
            </p>
          </Card>

          <Card title={`Destaques da vitrine${destaques.length ? ` (${destaques.length})` : ''}`}>
            {produtos.length === 0 ? (
              <EmptyState
                title="Nenhum produto publicado"
                description="Publique produtos em Produtos › Prontidão online. É lá que se decide o que a loja vende."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
                  <thead>
                    <tr className="text-left text-[var(--gs-muted)]">
                      <th className="py-2">Produto</th>
                      <th className="py-2">Código</th>
                      <th className="py-2 text-right">Preço</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {produtos.map((p) => (
                      <tr key={p.id} className="border-t border-[var(--gs-border)]">
                        <td className="py-2">
                          {p.name}
                          {p.featured_online === 1 && (
                            <span className="ml-2">
                              <Badge tone="success">Destaque</Badge>
                            </span>
                          )}
                        </td>
                        <td className="py-2 font-mono text-[var(--gs-muted)]">
                          {p.internal_code}
                        </td>
                        <td className="py-2 text-right">{formatCents(p.price_cents)}</td>
                        <td className="py-2 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void alternarDestaque(p)}
                          >
                            {p.featured_online === 1 ? 'Tirar destaque' : 'Destacar'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Só aparece aqui o que já está publicado. Despublicar um produto o tira da loja e do
              destaque junto — não há duas listas para divergirem.
            </p>
          </Card>
        </>
      )}
    </AppShell>
  );
}
