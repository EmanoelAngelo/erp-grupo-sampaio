/**
 * PLAQUINHAS — o pool, os lotes e a cara do adesivo (rodada 53).
 *
 * ## O que esta tela resolve
 *
 * A oficina não cadastra uma moto e imprime o adesivo dela em seguida: ela
 * manda imprimir uma folha de adesivos, cola nas máquinas do pátio, e só
 * depois senta para cadastrar cada uma com o número que já está colado. Sem
 * esta tela esse caminho não existia — a plaquinha nascia junto do
 * equipamento e não havia como ter adesivo antes da máquina.
 *
 * ## Os quatro estados, e por que a ordem importa
 *
 *   Gerada      o número foi reservado; o papel ainda não existe
 *   Disponível  a folha FOI exportada; o adesivo existe e pode ser colado
 *   Associada   já está numa máquina — e isso não se desfaz
 *   Danificada  o adesivo se perdeu, e o número morre com ele
 *
 * A tela não oferece "liberar" antes de exportar, porque o servidor recusa: o
 * número liberado sem papel é aceito pelo cadastro e não existe colado em
 * lugar nenhum. Aqui o botão de liberar só acende para lote que já foi ao
 * papel, e o aviso explica o que falta.
 *
 * ## Só na PJ Motors (P0 das plaquinhas)
 *
 * A rota abria em qualquer empresa e só depois o servidor dizia
 * `usaPlaquinha: false` — com a lista e o resumo do pool já entregues. Agora a
 * tela pergunta à SESSÃO antes de montar: fora da PJ Motors ela mostra "não
 * disponível nesta empresa" e não faz chamada nenhuma. O servidor recusa com
 * 403 do mesmo jeito, e a tela trata essa recusa como o mesmo estado (a PJ com
 * a plaquinha desligada cai nela).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Kpi,
  PageHeader,
  SearchInput,
} from '@/components/gs/ui';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { useHasProfile } from '@/hooks/useSession';
import { useEmpresaTemPlaquinha } from '@/hooks/useEmpresaTemPlaquinha';
import { dataHoraBR } from '@/lib/datas';
import { PLAQUINHA_SO_NA_PJ } from '@/lib/acesso/plaquinhaDaEmpresa';

interface Plaquinha {
  id: string;
  public_id: number;
  publicIdLabel: string;
  status: 'gerada' | 'disponivel' | 'associada' | 'danificada';
  batch_id: string | null;
  equipment_id: string | null;
  equipment_label: string | null;
  printed_at: string | null;
  damaged_reason: string | null;
  created_at: string;
}

interface Lote {
  batchId: string;
  criadoEm: string;
  total: number;
  geradas: number;
  disponiveis: number;
  associadas: number;
  danificadas: number;
  impressas: number;
  primeira: string;
  ultima: string;
}

interface Layout {
  logoUrl: string | null;
  logoXmm: number;
  logoYmm: number;
  logoWmm: number;
  logoHmm: number;
  bgColor: string;
  textColor: string;
  rounded: boolean;
  widthMm: number;
  heightMm: number;
  marginMm: number;
}

interface FormatoPlaquinha {
  id: string;
  label: string;
  hint: string;
}

const ROTULO: Record<Plaquinha['status'], { texto: string; tom: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  gerada: { texto: 'Gerada', tom: 'warning' },
  disponivel: { texto: 'Livre', tom: 'success' },
  associada: { texto: 'Na máquina', tom: 'neutral' },
  danificada: { texto: 'Danificada', tom: 'danger' },
};

/**
 * A folha vem pronta do servidor: aqui só se abre a janela para imprimir.
 *
 * Devolve `false` quando o pop-up foi bloqueado e o arquivo teve de ser
 * baixado. A diferença importa: nesse instante as plaquinhas JÁ estão marcadas
 * como impressas no servidor, e sem o aviso a pessoa vê "folha gerada" sem
 * folha nenhuma na tela — e vai procurar o papel que ficou na pasta de
 * downloads.
 */
function abrirFolha(html: string, nome: string): boolean {
  const janela = window.open('', '_blank');
  if (janela) {
    janela.document.write(html);
    janela.document.close();
    return true;
  }
  // O caminho do arquivo pode falhar também (navegador sem createObjectURL,
  // download bloqueado): o aviso de que a folha existe não pode se perder
  // junto, porque as plaquinhas já foram marcadas como impressas.
  try {
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    // Sem janela e sem arquivo: o aviso ao lado é o que resta.
  }
  return false;
}

function quando(iso: string | null): string {
  if (!iso) return '—';
  return dataHoraBR(iso);
}

/**
 * A PORTA DA ROTA: fora da PJ Motors, o estado "não disponível" e nenhuma
 * chamada. Componente separado porque o pool abaixo dispara as leituras num
 * efeito — e efeito não se pula com `if` depois de declarado.
 */
export default function PlaquinhasPage() {
  const temPlaquinha = useEmpresaTemPlaquinha();
  if (!temPlaquinha) return <PlaquinhasIndisponiveis />;
  return <PoolDePlaquinhas />;
}

function PlaquinhasIndisponiveis({ motivo = PLAQUINHA_SO_NA_PJ }: { motivo?: string }) {
  return (
    <AppShell>
      <PageHeader breadcrumb={['Oficina', 'Plaquinhas']} title="Plaquinhas" />
      <Card>
        <EmptyState title="Plaquinhas não disponíveis nesta empresa" description={motivo} />
      </Card>
    </AppShell>
  );
}

function PoolDePlaquinhas() {
  const [itens, setItens] = useState<Plaquinha[]>([]);
  const [lotes, setLotes] = useState<Lote[]>([]);
  const [resumo, setResumo] = useState<Record<string, number>>({});
  const [usaPlaquinha, setUsaPlaquinha] = useState(true);
  /** A frase do servidor quando ele recusa a empresa (403 da regra de ouro). */
  const [motivoSemPlaquinha, setMotivoSemPlaquinha] = useState<string | undefined>(undefined);
  /*
    A operação SEM BANCADA não gera plaquinha (GAP-PRD-110): a PJ Motors adota a
    plaquinha da Oficina pela unidade. `true` até o servidor dizer o contrário —
    servidor antigo não manda o campo, e aí nada muda.
  */
  const [temBancada, setTemBancada] = useState(true);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [formatos, setFormatos] = useState<FormatoPlaquinha[]>([]);
  const [formatoId, setFormatoId] = useState('plaq_a4_63x33_3col');
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<string>('');
  const [busca, setBusca] = useState('');
  const [quantidade, setQuantidade] = useState('50');
  const [editando, setEditando] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [danificando, setDanificando] = useState<Plaquinha | null>(null);
  const [motivo, setMotivo] = useState('');
  /** A carga falhou: lista vazia aqui e "nao sei", nao "nao ha". */
  const [falhouCarga, setFalhouCarga] = useState(false);
  /** Quantas a busca ENCONTROU — a lista mostra no maximo 300. */
  const [totalFiltrado, setTotalFiltrado] = useState(0);

  const podeGerar = useHasProfile('gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista');
  const podeEditarLayout = useHasProfile('gerente_oficina', 'gerente_loja');
  /*
    LIBERAR e de quem responde pelo lote, nao de quem o gera.

    A rota de liberacao aceita gerente de oficina, gerente de loja e
    estoquista; o mecanico gera lote e imprime, mas nao libera. Oferecer o
    botao a ele era oferecer um 403.
  */
  const podeLiberar = useHasProfile('gerente_oficina', 'gerente_loja', 'estoquista');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const params = new URLSearchParams();
      if (filtro) params.set('status', filtro);
      if (busca.trim()) params.set('busca', busca.trim());
      const [pool, batches, cfg, fmts] = await Promise.all([
        apiRequest<{
          items: Plaquinha[];
          total: number;
          resumo: Record<string, number>;
          usaPlaquinha: boolean;
          temBancada?: boolean;
        }>(
          `/core/equipment-tags${params.toString() ? `?${params}` : ''}`,
        ),
        apiRequest<{ items: Lote[] }>('/core/equipment-tags/batches').catch(() => ({ items: [] })),
        apiRequest<{ layout: Layout }>('/core/equipment-tags/layout').catch(() => null),
        apiRequest<{ items: FormatoPlaquinha[] }>('/core/labels/equipment/formats').catch(() => ({
          items: [],
        })),
      ]);
      setItens(pool.items ?? []);
      setTotalFiltrado(Number(pool.total ?? (pool.items ?? []).length));
      setResumo(pool.resumo ?? {});
      setUsaPlaquinha(pool.usaPlaquinha);
      setTemBancada(pool.temBancada !== false);
      setLotes(batches.items ?? []);
      if (cfg) setLayout(cfg.layout);
      /*
        O formato que segue os MILÍMETROS DO EDITOR entra no seletor.

        Sem ele, o editor prometia largura e altura que a folha ignorava: o
        papel saía com a geometria do formato escolhido, e a divergência só
        aparecia na impressora.
      */
      setFormatos([
        ...(fmts.items ?? []),
        {
          id: 'plaq_personalizado',
          label: cfg
            ? `Personalizado — ${cfg.layout.widthMm} × ${cfg.layout.heightMm} mm`
            : 'Personalizado (o tamanho do editor)',
          hint: 'Usa a largura e a altura definidas no editor de layout.',
        },
      ]);
      setFalhouCarga(false);
    } catch (err) {
      /*
        A RECUSA DA REGRA DE OURO NÃO É FALHA DE LEITURA (P0 das plaquinhas).

        O servidor responde 403 `CORE_COMPANY_NO_TAGS` a toda rota de plaquinha
        fora da PJ Motors — e à PJ com a marca desligada. Isso é a empresa sem a
        função, e a tela diz isso, em vez do alarme de "não consegui ler".
      */
      if (err instanceof ApiRequestError && err.code === 'CORE_COMPANY_NO_TAGS') {
        setUsaPlaquinha(false);
        setMotivoSemPlaquinha(err.message);
        return;
      }
      /*
        "Não consegui carregar" NÃO é "não há plaquinha".

        Com a lista zerada e o aviso de erro rolado para fora da tela, o pool
        aparecia vazio com toda a confiança — e o caminho seguinte é gerar um
        lote que talvez já exista.
      */
      setFalhouCarga(true);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar as plaquinhas.');
    } finally {
      setCarregando(false);
    }
  }, [filtro, busca]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /**
   * O molde das ações: ocupa, executa, relê e explica.
   *
   * `releitura: false` existe por causa da PRÉVIA. Reler traz o layout GRAVADO
   * do servidor e sobrescreve o formulário: quem mexia nas cores, clicava em
   * "Ver como fica" e depois em "Salvar", gravava os valores velhos — e a tela
   * dizia "Layout salvo" com todas as letras.
   */
  async function executar(acao: () => Promise<string | void>, releitura = true) {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const mensagem = await acao();
      if (mensagem) setAviso(mensagem);
      if (releitura) await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível concluir a ação.');
    } finally {
      setOcupado(false);
    }
  }

  const selecionaveis = useMemo(() => itens.filter((t) => t.status === 'gerada'), [itens]);

  if (!usaPlaquinha && !carregando) {
    // A frase antiga dizia "da PJ Motors e da Oficina": a regra mudou, e a
    // tela repete a do servidor quando ele a manda.
    return <PlaquinhasIndisponiveis motivo={motivoSemPlaquinha} />;
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Oficina', 'Plaquinhas']}
        title="Plaquinhas"
        subtitle="O adesivo existe antes da máquina: gere o lote, imprima a folha, cole e cadastre."
        actions={
          podeEditarLayout ? (
            <Button variant="secondary" onClick={() => setEditando((v) => !v)}>
              {editando ? 'Fechar o editor' : 'Editar o layout'}
            </Button>
          ) : undefined
        }
      />

      {erro && (
        <p
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}
      {aviso && (
        <p
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {aviso}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-5">
        <Kpi label="Total" value={String(resumo.total ?? 0)} />
        <Kpi label="Geradas" value={String(resumo.gerada ?? 0)} hint="Falta ir ao papel" tone="warning" />
        <Kpi label="Livres" value={String(resumo.disponivel ?? 0)} hint="Prontas para colar" />
        <Kpi label="Na máquina" value={String(resumo.associada ?? 0)} />
        <Kpi label="Danificadas" value={String(resumo.danificada ?? 0)} />
      </div>

      {/*
        A OPERAÇÃO QUE ADOTA, E NÃO GERA (GAP-PRD-110).

        A PJ Motors usa plaquinha — a moto dela recebe a da Oficina pela unidade —
        mas não tem bancada: nenhum perfil dela cadastra máquina, e a Oficina
        recusa plaquinha de outra operação. O lote gerado aqui queimava números
        do grupo em adesivos que nunca entrariam numa máquina, e o QR respondia
        404. Sem bancada, a tela explica o caminho certo em vez do botão.
      */}
      {!temBancada && (
        <section
          aria-label="Operação sem bancada"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]"
        >
          <strong>Esta operação não tem bancada: a plaquinha vem da oficina.</strong> Quem gera,
          imprime e cola o adesivo é a oficina que monta a moto; aqui a moto recebe a plaquinha em{' '}
          <strong>Estoque › Unidades</strong> (Vincular plaquinha). Plaquinha gerada aqui antes desta
          regra não entra em máquina nenhuma — marque-a como danificada para o número não circular.
        </section>
      )}

      {podeGerar && temBancada && (
        <Card
          title="Gerar lote"
          subtitle="Os números saem da sequência do grupo — nunca se repetem, nem entre operações."
          className="mb-5"
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Quantas plaquinhas" hint="No máximo 1.000 por lote.">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  max={1000}
                  value={quantidade}
                  onChange={(e) => setQuantidade(e.target.value)}
                />
              )}
            </Field>
            <Button
              loading={ocupado}
              onClick={() =>
                void executar(async () => {
                  const lote = await apiRequest<{ criadas: number; primeira: number; ultima: number }>(
                    '/core/equipment-tags/batches',
                    { method: 'POST', body: { quantidade: Number(quantidade) } },
                  );
                  return `${lote.criadas} plaquinha(s) reservadas. Imprima a folha para liberá-las.`;
                })
              }
            >
              Gerar
            </Button>
          </div>
        </Card>
      )}

      {editando && layout && (
        <Card
          title="A cara da plaquinha"
          subtitle="Vale para a operação inteira — não é do navegador de quem editou."
          className="mb-5"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Cor de fundo">
              {(p) => (
                <input
                  {...p}
                  type="color"
                  value={layout.bgColor}
                  onChange={(e) => setLayout({ ...layout, bgColor: e.target.value })}
                  className="h-10 w-full rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                />
              )}
            </Field>
            <Field label="Cor do texto">
              {(p) => (
                <input
                  {...p}
                  type="color"
                  value={layout.textColor}
                  onChange={(e) => setLayout({ ...layout, textColor: e.target.value })}
                  className="h-10 w-full rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                />
              )}
            </Field>
            <Field label="Logo" hint="PNG, JPEG, WebP ou SVG, até 512 KB.">
              {(p) => (
                <input
                  {...p}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const arquivo = e.target.files?.[0];
                    e.target.value = '';
                    if (!arquivo) return;
                    const leitor = new FileReader();
                    leitor.onload = () =>
                      setLayout({ ...layout, logoUrl: String(leitor.result ?? '') });
                    leitor.readAsDataURL(arquivo);
                  }}
                />
              )}
            </Field>
            {(
              [
                ['widthMm', 'Largura (mm)'],
                ['heightMm', 'Altura (mm)'],
                ['marginMm', 'Margem (mm)'],
                ['logoXmm', 'Logo — X (mm)'],
                ['logoYmm', 'Logo — Y (mm)'],
                ['logoWmm', 'Logo — largura (mm)'],
                ['logoHmm', 'Logo — altura (mm)'],
              ] as const
            ).map(([campo, rotulo]) => (
              <Field key={campo} label={rotulo}>
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    step="0.5"
                    value={String(layout[campo])}
                    onChange={(e) => setLayout({ ...layout, [campo]: Number(e.target.value) })}
                  />
                )}
              </Field>
            ))}
            <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
              <input
                type="checkbox"
                checked={layout.rounded}
                onChange={(e) => setLayout({ ...layout, rounded: e.target.checked })}
              />
              Cantos arredondados
            </label>
          </div>

          <div className="flex flex-wrap gap-2 mt-4">
            <Button
              loading={ocupado}
              onClick={() =>
                void executar(async () => {
                  await apiRequest('/core/equipment-tags/layout', { method: 'PUT', body: layout });
                  return 'Layout salvo para a operação.';
                })
              }
            >
              Salvar layout
            </Button>
            {/*
              A PRÉ-VISUALIZAÇÃO VEM DO SERVIDOR, do MESMO desenho que imprime.
              Desenhar a prévia aqui em CSS seria uma segunda verdade sobre o
              papel — e a primeira divergência apareceria só na impressora.
            */}
            <Button
              variant="secondary"
              loading={ocupado}
              onClick={() =>
                void executar(async () => {
                  const res = await apiRequest<{ html: string }>('/core/equipment-tags/sheet', {
                    method: 'POST',
                    body: { preview: true, layout, formatId: formatoId },
                  });
                  setPreview(res.html);
                }, false)
              }
            >
              Ver como fica
            </Button>
            {layout.logoUrl && (
              <Button variant="ghost" onClick={() => setLayout({ ...layout, logoUrl: null })}>
                Remover a logo
              </Button>
            )}
          </div>

          {preview && (
            <iframe
              title="Prévia da plaquinha"
              srcDoc={preview}
              className="w-full h-64 mt-4 rounded-[var(--gs-radius)] border border-[var(--gs-border)]"
            />
          )}
        </Card>
      )}

      <Card
        title="Lotes"
        subtitle="A folha é o que libera: sem papel, o número não vale para cadastro."
        className="mb-5"
      >
        {lotes.length === 0 ? (
          <EmptyState title="Nenhum lote" description="Gere o primeiro lote acima." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr>
                  <th className="text-left py-2">Criado</th>
                  <th className="text-left py-2">Faixa</th>
                  <th className="text-right py-2">Total</th>
                  <th className="text-right py-2">A liberar</th>
                  <th className="text-right py-2">Livres</th>
                  <th className="text-right py-2">Na máquina</th>
                  <th className="text-right py-2">Ações</th>
                </tr>
              </thead>
              <tbody>
                {lotes.map((l) => (
                  <tr key={l.batchId} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">{quando(l.criadoEm)}</td>
                    <td className="py-2 font-mono">
                      {l.primeira} … {l.ultima}
                    </td>
                    <td className="py-2 text-right">{l.total}</td>
                    <td className="py-2 text-right">{l.geradas}</td>
                    <td className="py-2 text-right">{l.disponiveis}</td>
                    <td className="py-2 text-right">{l.associadas}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="secondary"
                        // Vários lotes, vários botões iguais: o nome diz a faixa.
                        aria-label={`Imprimir a folha do lote ${l.primeira} a ${l.ultima}`}
                        disabled={ocupado}
                        onClick={() =>
                          void executar(async () => {
                            /*
                              O LOTE VAI INTEIRO, pelo id do lote.

                              A primeira versão listava as plaquinhas antes e
                              mandava os ids — e a lista tem teto: num lote de
                              mil, as que sobrassem da janela nunca iam ao
                              papel, e sem papel não há liberação. O lote fica
                              preso em "gerada" para sempre.
                            */
                            const res = await apiRequest<{
                              html: string;
                              folhas: number;
                              plaquinhas: number;
                              abaixoDoPiso: boolean;
                              moduloMm: number;
                              baseUrlConfigurada: boolean;
                              baseUrl: string;
                            }>('/core/equipment-tags/sheet', {
                              method: 'POST',
                              body: { batchId: l.batchId, formatId: formatoId },
                            });
                            const abriu = abrirFolha(
                              res.html,
                              `plaquinhas-${l.primeira}-${l.ultima}.html`,
                            );
                            /*
                              Os dois avisos que decidem se vale gastar adesivo,
                              e que a tela de Etiquetas já dava:
                              módulo abaixo do piso a câmera não lê, e endereço
                              público não configurado faz o QR apontar para um
                              domínio de reserva — descoberto quando o cliente
                              tenta escanear, com o adesivo já colado.
                            */
                            const alertas: string[] = [];
                            if (!abriu) {
                              alertas.push(
                                'o navegador bloqueou a janela e a folha foi baixada como arquivo '
                                + '(as plaquinhas já contam como impressas)',
                              );
                            }
                            if (res.abaixoDoPiso) {
                              alertas.push(
                                `o QR ficou com ${res.moduloMm.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mm por módulo, abaixo do `
                                + 'piso de 0,5 mm — celular comum pode não ler',
                              );
                            }
                            if (!res.baseUrlConfigurada) {
                              alertas.push(
                                `o endereço público não está configurado: o QR aponta para ${res.baseUrl}`,
                              );
                            }
                            return (
                              `${res.folhas} folha(s) com ${res.plaquinhas} plaquinha(s). `
                              + `Agora libere o lote.${alertas.length ? ` Atenção: ${alertas.join('; ')}.` : ''}`
                            );
                          })
                        }
                      >
                        Imprimir folha
                      </Button>{' '}
                      {podeLiberar && (<Button
                        size="sm"
                        aria-label={`Liberar o lote ${l.primeira} a ${l.ultima}`}
                        disabled={ocupado || l.geradas === 0}
                        title={
                          l.geradas === 0
                            ? 'Nada a liberar neste lote.'
                            : l.impressas === 0
                              ? 'Imprima a folha antes: número liberado sem adesivo não existe.'
                              : undefined
                        }
                        onClick={() =>
                          void executar(async () => {
                            const res = await apiRequest<{ liberadas: number }>(
                              '/core/equipment-tags/release',
                              { method: 'POST', body: { batchId: l.batchId } },
                            );
                            return `${res.liberadas} plaquinha(s) liberadas para uso.`;
                          })
                        }
                      >
                        Liberar
                      </Button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {formatos.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <label className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]" htmlFor="formato-folha">
              Formato da folha
            </label>
            <select
              id="formato-folha"
              value={formatoId}
              onChange={(e) => setFormatoId(e.target.value)}
              className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            >
              {formatos.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </Card>

      <Card
        title={`Plaquinhas (${itens.length})`}
        subtitle={
          totalFiltrado > itens.length
            ? `Mostrando ${itens.length} de ${totalFiltrado} — refine pela busca ou pela situação.`
            : 'Busque pelo número — #0007, 0007 ou 7 são a mesma.'
        }
      >
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <SearchInput
            value={busca}
            onChange={setBusca}
            placeholder="Ex.: #0007 ou o nome da máquina"
          />
          <select
            aria-label="Situação"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          >
            <option value="">Todas</option>
            <option value="gerada">Geradas</option>
            <option value="disponivel">Livres</option>
            <option value="associada">Na máquina</option>
            <option value="danificada">Danificadas</option>
          </select>
          {selecionaveis.length > 0 && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {selecionaveis.length} à espera de papel
            </span>
          )}
        </div>

        {carregando ? (
          <p role="status">Carregando…</p>
        ) : itens.length === 0 ? (
          <EmptyState
            title={falhouCarga ? 'Não foi possível ler as plaquinhas' : 'Nenhuma plaquinha'}
            description={
              falhouCarga
                ? 'A lista acima está vazia porque a leitura falhou — não porque o pool esteja vazio. Recarregue antes de gerar lote.'
                : 'Gere um lote e imprima a folha para começar.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr>
                  <th className="text-left py-2">Número</th>
                  <th className="text-left py-2">Situação</th>
                  <th className="text-left py-2">Máquina</th>
                  <th className="text-left py-2">No papel</th>
                  <th className="text-right py-2">Ações</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((t) => (
                  <tr key={t.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2 font-mono font-semibold">{t.publicIdLabel}</td>
                    <td className="py-2">
                      <Badge tone={ROTULO[t.status].tom}>{ROTULO[t.status].texto}</Badge>
                      {t.damaged_reason && (
                        <span className="ml-2 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                          {t.damaged_reason}
                        </span>
                      )}
                    </td>
                    <td className="py-2">{t.equipment_label || '—'}</td>
                    <td className="py-2">{quando(t.printed_at)}</td>
                    <td className="py-2 text-right">
                      {t.status !== 'associada' && t.status !== 'danificada' && podeGerar && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={ocupado}
                          /*
                            Trezentas linhas dão trezentos botões com o mesmo
                            nome: quem usa leitor de tela precisa saber DE QUAL
                            plaquinha é o botão em que o foco parou.
                          */
                          aria-label={`Marcar ${t.publicIdLabel} como danificada`}
                          onClick={() => {
                            setDanificando(t);
                            setMotivo('');
                          }}
                        >
                          Marcar danificada
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/*
          O painel de confirmação nasce longe do botão que o abriu — no fim de
          uma tabela que pode ter trezentas linhas. Sem estas quatro coisas,
          quem usa teclado tabula a tabela inteira para chegar ao campo: o
          diálogo se anuncia, o campo recebe o foco, Escape cancela, e a recusa
          aparece AQUI dentro, e não numa tarja no topo da página.
        */}
        {danificando && (
          <div
            role="dialog"
            aria-modal="false"
            aria-labelledby="titulo-danificar"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDanificando(null);
            }}
            className="mt-4 p-4 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]"
          >
            <p id="titulo-danificar" className="m-0 mb-2 font-semibold">
              Marcar {danificando.publicIdLabel} como danificada
            </p>
            <p className="m-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              O número morre com o adesivo: ele não volta para o sorteio.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="O que aconteceu">
                {(p) => (
                  <Input
                    {...p}
                    autoFocus
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="Ex.: impressão borrada"
                  />
                )}
              </Field>
              <Button
                loading={ocupado}
                onClick={() =>
                  void executar(async () => {
                    await apiRequest(`/core/equipment-tags/${danificando.id}/damage`, {
                      method: 'POST',
                      body: { motivo },
                    });
                    setDanificando(null);
                    return `${danificando.publicIdLabel} marcada como danificada.`;
                  })
                }
              >
                Confirmar
              </Button>
              <Button variant="ghost" onClick={() => setDanificando(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
