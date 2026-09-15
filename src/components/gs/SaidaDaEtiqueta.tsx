/**
 * A SAÍDA DA ETIQUETA — por onde ela sai, o que saiu, e o histórico.
 *
 * A folha só saía pelo diálogo do navegador. A térmica da loja que fala ZPL,
 * EPL ou TSPL imprimia pelo driver do Windows, com a escala e a margem que o
 * driver quisesse, e não havia como reimprimir o lote de ontem sem remontar a
 * fila à mão. Aqui:
 *
 *   - o SELETOR de saída (navegador, driver, PDF, ZPL, EPL, TSPL), com a dica
 *     de cada uma e a lista do que ainda precisa ser conferido numa impressora
 *     de verdade — nenhuma saída é declarada compatível sem o papel;
 *   - o RESULTADO: a prévia desenhada pelo servidor na mesma geometria do
 *     arquivo, o arquivo para baixar e os comandos para conferir;
 *   - o HISTÓRICO: quem imprimiu, quando, o quê, por qual saída — e o botão de
 *     reimprimir o mesmo lote.
 */
import { Badge, Button, Card, EmptyState } from '@/components/gs/ui';
import type { ArquivoDaEtiqueta, ImpressaoDeEtiquetas, ItemDeHomologacao, PerfilDeImpressao } from '@/lib/api/core';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const CAIXA =
  'h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] ' +
  'bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]';

/**
 * Baixa o arquivo da saída (PDF, ZPL, EPL, TSPL, HTML). O conteúdo vem em
 * base64 porque a EPL sai em Windows-1252 e o PDF é binário: texto JSON
 * estragaria os dois. Não exportada: o arquivo só exporta componentes (o
 * recarregamento rápido do Vite depende disso).
 */
function baixarArquivoDaEtiqueta(arquivo: ArquivoDaEtiqueta): void {
  const binario = atob(arquivo.base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: arquivo.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = arquivo.nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function SeletorDeSaida({
  perfis,
  valor,
  onMudar,
  homologacao,
  folha,
}: {
  perfis: PerfilDeImpressao[];
  valor: string;
  onMudar: (id: PerfilDeImpressao['id']) => void;
  homologacao: ItemDeHomologacao[];
  /** O formato escolhido é FOLHA (A4/Carta): as saídas só de rolo ficam indisponíveis, com o motivo. */
  folha: boolean;
}) {
  const atual = perfis.find((p) => p.id === valor);
  const conferir = atual ? homologacao.filter((h) => h.saida === 'todas' || h.saida === atual.saida) : [];
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className={ROTULO}>Saída da impressão</span>
        <select
          aria-label="Saída da impressão"
          value={valor}
          onChange={(e) => onMudar(e.target.value as PerfilDeImpressao['id'])}
          className={CAIXA}
        >
          {perfis.map((p) => (
            <option key={p.id} value={p.id} disabled={folha && !p.aceitaFolha}>
              {p.rotulo}
              {folha && !p.aceitaFolha ? ' — só rolo' : ''}
            </option>
          ))}
        </select>
      </label>
      {atual && <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">{atual.dica}</p>}
      {atual && atual.id !== 'navegador' && conferir.length > 0 && (
        <details data-testid="homologacao-da-saida" className="text-[length:var(--gs-text-sm)]">
          <summary className="cursor-pointer text-[var(--gs-warning)]">
            Ainda não conferida em papel: o que testar numa impressora de verdade antes de confiar nesta saída ({conferir.length})
          </summary>
          <ul className="m-0 mt-1 pl-5">
            {conferir.map((h) => (
              <li key={`${h.saida}-${h.item}`}>
                <strong>{h.item}</strong> — {h.como}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export interface ResultadoDaSaida {
  titulo: string;
  html: string;
  arquivo: ArquivoDaEtiqueta | null;
  comandos: string | null;
  avisos: string[];
}

export function ResultadoDaImpressao({ resultado, onFechar }: { resultado: ResultadoDaSaida; onFechar: () => void }) {
  const arquivo = resultado.arquivo;
  return (
    <Card
      title={resultado.titulo}
      subtitle="A prévia é desenhada com a mesma geometria do arquivo: posição, tamanho e barras em pontos da impressora. A letra da térmica pode sair um pouco mais estreita que a da tela."
      className="mb-5"
      actions={
        <div className="flex gap-2 flex-wrap">
          {arquivo && (
            <Button size="sm" onClick={() => baixarArquivoDaEtiqueta(arquivo)}>
              Baixar {arquivo.nome}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onFechar}>
            Fechar
          </Button>
        </div>
      }
    >
      {resultado.avisos.length > 0 && (
        <ul
          data-testid="avisos-da-saida"
          className="m-0 mb-3 pl-5 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]"
        >
          {resultado.avisos.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      <iframe
        title="Prévia da impressão"
        srcDoc={resultado.html}
        className="w-full h-[420px] border border-[var(--gs-border)] rounded-[var(--gs-radius)] bg-white"
      />
      {resultado.comandos && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[length:var(--gs-text-sm)]">
            Comandos da impressora{arquivo ? ` (${arquivo.nome})` : ''}
          </summary>
          <pre
            data-testid="comandos-da-impressora"
            className="mt-2 max-h-64 overflow-auto p-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)] text-[length:var(--gs-text-xs)]"
          >
            {resultado.comandos}
          </pre>
        </details>
      )}
    </Card>
  );
}

const TIPO: Record<ImpressaoDeEtiquetas['kind'], string> = { lote: 'folha', reimpressao: 'reimpressão', teste: 'teste' };

export function HistoricoDeEtiquetas({
  itens,
  perfis,
  onReimprimir,
  ocupado,
}: {
  itens: ImpressaoDeEtiquetas[];
  perfis: PerfilDeImpressao[];
  onReimprimir: (impressao: ImpressaoDeEtiquetas) => void;
  ocupado: boolean;
}) {
  if (itens.length === 0) {
    return (
      <EmptyState
        title="Nenhuma impressão ainda"
        description="Cada folha gerada, reimpressão e etiqueta de teste aparece aqui, com quem imprimiu."
      />
    );
  }
  const rotuloDoPerfil = (id: string) => perfis.find((p) => p.id === id)?.rotulo ?? id;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[length:var(--gs-text-sm)]" aria-label="Histórico de impressão de etiquetas">
        <thead>
          <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
            <th className="py-2 px-3 font-semibold">Quando</th>
            <th className="py-2 px-3 font-semibold">Quem</th>
            <th className="py-2 px-3 font-semibold">O quê</th>
            <th className="py-2 px-3 font-semibold">Formato e saída</th>
            <th className="py-2 px-3 font-semibold text-right">Etiquetas</th>
            <th className="py-2 px-3" />
          </tr>
        </thead>
        <tbody>
          {itens.map((i) => {
            const quando = new Date(i.createdAt).toLocaleString('pt-BR');
            return (
              <tr key={i.id} className="border-b border-[var(--gs-border)] last:border-0">
                <td className="py-2 px-3 whitespace-nowrap">
                  {quando} <Badge tone={i.kind === 'lote' ? 'info' : 'neutral'}>{TIPO[i.kind]}</Badge>
                </td>
                <td className="py-2 px-3">{i.userName ?? i.userId ?? '—'}</td>
                <td className="py-2 px-3">
                  {i.kind === 'teste'
                    ? 'Etiqueta de teste'
                    : i.items.slice(0, 3).map((it) => `${it.name} × ${it.quantity}`).join(', ')
                      + (i.items.length > 3 ? ` e mais ${i.items.length - 3}` : '')}
                </td>
                <td className="py-2 px-3">
                  {i.formatName} · {rotuloDoPerfil(i.profile)}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{i.labels}</td>
                <td className="py-2 px-3 text-right">
                  {i.kind !== 'teste' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={ocupado}
                      onClick={() => onReimprimir(i)}
                      aria-label={`Reimprimir a impressão de ${quando}`}
                    >
                      Reimprimir
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
