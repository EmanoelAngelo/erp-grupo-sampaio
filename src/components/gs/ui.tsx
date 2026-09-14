/**
 * Primitivas de interface do Grupo Sampaio.
 *
 * Todas consomem os tokens de `src/design/tokens.css` — nenhuma cor literal.
 * São deliberadamente pequenas e sem estado: densidade, tipografia e
 * espaçamento vêm daqui para que as telas fiquem consistentes entre si.
 */
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
import { useId, useState } from 'react';
import { IconeCruz, IconeMais } from './icons';
import type { CampoFiltravel, FiltroAtivo } from './filtros';

// ----------------------------------------------------------------- Filtros

/**
 * Filtros em chip, como na referência.
 *
 * POR QUE CHIP E NÃO UM PAINEL DE FORMULÁRIO
 *
 * O filtro aplicado precisa ficar VISÍVEL. Painel que fecha esconde o que está
 * filtrando, e aí a lista mostra 3 de 400 linhas sem dizer por quê — a pessoa
 * conclui que o dado sumiu. Cada chip mostra o critério por extenso e traz o
 * próprio botão de remover, então desfazer é um clique no lugar óbvio.
 *
 * O estado mora em quem chama: esta lista é a mesma que vai para a consulta, e
 * duplicá-la aqui dentro criaria duas verdades sobre o que está filtrado.
 */
export function Filtros({
  campos,
  ativos,
  onChange,
  children,
}: {
  campos: CampoFiltravel[];
  ativos: FiltroAtivo[];
  onChange: (proximos: FiltroAtivo[]) => void;
  /** Ações à direita — "Editar múltiplos", exportar, etc. */
  children?: ReactNode;
}) {
  const [abrindo, setAbrindo] = useState(false);
  const [campo, setCampo] = useState('');
  const [valor, setValor] = useState('');

  const disponiveis = campos.filter((c) => !ativos.some((a) => a.campo === c.campo));
  const selecionado = campos.find((c) => c.campo === campo);
  const rotuloDe = (nome: string) => campos.find((c) => c.campo === nome)?.rotulo ?? nome;
  const valorLegivel = (f: FiltroAtivo) => {
    const def = campos.find((c) => c.campo === f.campo);
    return def?.opcoes?.find((o) => o.valor === f.valor)?.rotulo ?? f.valor;
  };

  const aplicar = () => {
    if (!campo || !valor.trim()) return;
    onChange([...ativos, { campo, valor: valor.trim() }]);
    setCampo('');
    setValor('');
    setAbrindo(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {ativos.map((f) => (
          <span
            key={f.campo}
            className="inline-flex items-center gap-2 pl-3 pr-1.5 py-1
              rounded-full bg-[var(--gs-purple-700)] text-white
              text-[length:var(--gs-text-sm)] font-semibold"
          >
            {rotuloDe(f.campo)}: {valorLegivel(f)}
            <button
              type="button"
              onClick={() => onChange(ativos.filter((a) => a.campo !== f.campo))}
              aria-label={`Remover filtro ${rotuloDe(f.campo)}`}
              className="flex items-center justify-center w-5 h-5 rounded-full border-0
                bg-white/20 hover:bg-white/35 text-white cursor-pointer p-0 transition-colors"
            >
              <IconeCruz size={11} />
            </button>
          </span>
        ))}

        {disponiveis.length > 0 && (
          <button
            type="button"
            onClick={() => setAbrindo((v) => !v)}
            aria-expanded={abrindo}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--gs-radius)]
              border-0 bg-[var(--gs-orange-500)] hover:bg-[var(--gs-orange-600)]
              text-white text-[length:var(--gs-text-sm)] font-semibold cursor-pointer transition-colors"
          >
            <IconeMais size={13} />
            Adicionar filtro
          </button>
        )}

        {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
      </div>

      {abrindo && (
        <div
          className="flex flex-wrap items-end gap-3 p-4 rounded-[var(--gs-radius)]
            border border-[var(--gs-border)] bg-[var(--gs-surface-hover)]"
        >
          <Field label="Campo">
            {(props) => (
              <select
                {...props}
                value={campo}
                onChange={(e) => {
                  setCampo(e.target.value);
                  setValor('');
                }}
                className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]"
              >
                <option value="">Escolha um campo</option>
                {disponiveis.map((c) => (
                  <option key={c.campo} value={c.campo}>
                    {c.rotulo}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Valor">
            {(props) =>
              selecionado?.opcoes ? (
                <select
                  {...props}
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                    bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]"
                >
                  <option value="">Escolha</option>
                  {selecionado.opcoes.map((o) => (
                    <option key={o.valor} value={o.valor}>
                      {o.rotulo}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  {...props}
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                  disabled={!campo}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      aplicar();
                    }
                  }}
                />
              )
            }
          </Field>

          <Button onClick={aplicar} disabled={!campo || !valor.trim()}>
            Aplicar
          </Button>
          <Button variant="ghost" onClick={() => setAbrindo(false)}>
            Cancelar
          </Button>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- Card

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  padded = true,
  collapsible = false,
}: {
  title?: ReactNode;
  /**
   * Linha de apoio sob o título.
   *
   * Não é enfeite: é onde ficam as frases que dizem o que o card faz e o que
   * ele NÃO faz — "numeração inutilizada não volta", "nada é corrigido
   * automaticamente". Quarenta e cinco telas passavam esta propriedade sem que
   * o componente a aceitasse, e o texto sumia sem ninguém perceber.
   */
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
  /** Mostra o controle de recolher no canto, como nos cards da referência. */
  collapsible?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section
      className={`bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] shadow-[var(--gs-shadow)] ${className}`}
    >
      {(title || subtitle || actions || collapsible) && (
        // Sem borda inferior: na referência o título flutua sobre o card e a
        // separação vem do espaçamento, não de um traço.
        <header className="flex items-center justify-between gap-4 px-5 pt-4 pb-3">
          <div className="flex flex-col gap-1 min-w-0">
            {typeof title === 'string' ? (
              <h2 className="text-[17px] font-semibold text-[var(--gs-purple-900)] m-0">{title}</h2>
            ) : (
              title
            )}
            {subtitle && (
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">{subtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-3 text-[var(--gs-muted)]">
            {actions}
            {collapsible && (
              <button
                type="button"
                aria-label={collapsed ? 'Expandir' : 'Recolher'}
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((v) => !v)}
                className="bg-transparent border-0 cursor-pointer text-[var(--gs-muted)]
                  hover:text-[var(--gs-purple-700)] text-[length:var(--gs-text-base)] px-1"
              >
                {collapsed ? '⌄' : '⌃'}
              </button>
            )}
          </div>
        </header>
      )}
      {!collapsed && <div className={padded ? 'px-5 pb-5' : ''}>{children}</div>}
    </section>
  );
}

/**
 * Campo de busca grande com lupa à esquerda e placeholder em itálico — é o
 * elemento que abre praticamente toda listagem na referência.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  onEnter,
  inputRef,
  autoFocus,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onEnter?: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
  autoFocus?: boolean;
  /** Teclas que a tela trata antes do Enter (setas, Esc). preventDefault() cancela o onEnter. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="relative w-full">
      <span
        aria-hidden
        className="absolute left-4 top-1/2 -translate-y-1/2 text-[20px] text-[var(--gs-purple-700)]"
      >
        ⌕
      </span>
      <input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full h-[52px] pl-12 pr-4 rounded-[var(--gs-radius)]
          border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
          text-[length:var(--gs-text-lg)] text-[var(--gs-text)]
          placeholder:italic placeholder:text-[var(--gs-muted)]
          focus:border-[var(--gs-purple-700)]"
      />
    </div>
  );
}

/**
 * Estado vazio de gráfico: caixa tracejada centrada dentro do card, como na
 * referência — comunica "sem dados" sem parecer que a tela quebrou.
 */
export function ChartEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex items-center justify-center py-14">
      <div className="border border-dashed border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-8 py-6 text-center max-w-sm">
        <p className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-purple-900)] m-0">
          {title}
        </p>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-0">{description}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Button

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--gs-purple-700)] text-white border-transparent hover:bg-[var(--gs-purple-800)]',
  secondary:
    'bg-[var(--gs-surface)] text-[var(--gs-text)] border-[var(--gs-border-strong)] hover:bg-[var(--gs-surface-hover)]',
  ghost:
    'bg-transparent text-[var(--gs-purple-700)] border-transparent hover:bg-[var(--gs-purple-100)]',
  danger: 'bg-[var(--gs-danger)] text-white border-transparent hover:opacity-90',
  success: 'bg-[var(--gs-orange-500)] text-white border-transparent hover:bg-[var(--gs-orange-600)]',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}) {
  const sizing =
    size === 'lg'
      ? 'px-6 py-3 text-[length:var(--gs-text-lg)]'
      : size === 'sm'
        ? 'px-3 py-1.5 text-[length:var(--gs-text-sm)]'
        : 'px-4 py-2 text-[length:var(--gs-text-base)]';
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-[var(--gs-radius)] border font-semibold
        transition-colors disabled:opacity-50 disabled:cursor-not-allowed
        ${BUTTON_STYLES[variant]} ${sizing} ${className}`}
    >
      {loading && (
        <span
          aria-hidden
          className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin"
        />
      )}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------- Field

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
        {label}
        {required && (
          <span className="text-[var(--gs-danger)] ml-1" aria-hidden>
            *
          </span>
        )}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          {hint}
        </p>
      )}
      {/* role=alert para que o leitor de tela anuncie o erro na hora */}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0"
        >
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
        bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]
        placeholder:text-[var(--gs-muted)]
        focus:border-[var(--gs-purple-700)] ${className}`}
    />
  );
}

// ------------------------------------------------------------------- Badge

const BADGE_STYLES = {
  neutral: 'bg-[var(--gs-surface-hover)] text-[var(--gs-text-soft)]',
  success: 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]',
  warning: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
  danger: 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]',
  info: 'bg-[var(--gs-info-bg)] text-[var(--gs-info)]',
} as const;

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof BADGE_STYLES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[length:var(--gs-text-sm)] font-semibold ${BADGE_STYLES[tone]}`}
    >
      {children}
    </span>
  );
}

// -------------------------------------------------------------- EmptyState

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      {icon && <div className="text-[var(--gs-purple-600)] opacity-40 mb-3">{icon}</div>}
      <p className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] m-0">{title}</p>
      {description && (
        <p className="text-[length:var(--gs-text-base)] text-[var(--gs-muted)] mt-1.5 mb-0 max-w-md">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// --------------------------------------------------------------- PageHeader

export function PageHeader({
  breadcrumb,
  title,
  subtitle,
  actions,
}: {
  breadcrumb?: string[];
  title: string;
  /** Uma linha dizendo o que esta tela resolve. Ver a nota em `Card`. */
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 mb-5">
      <div>
        {breadcrumb && breadcrumb.length > 0 && (
          <nav aria-label="Trilha de navegação" className="mb-1">
            <ol className="flex items-center gap-1.5 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] list-none p-0 m-0">
              {breadcrumb.map((crumb, i) => (
                <li key={crumb} className="flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden>›</span>}
                  <span className={i === breadcrumb.length - 1 ? 'font-semibold' : ''}>{crumb}</span>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 className="text-[length:var(--gs-text-2xl)] font-semibold text-[var(--gs-purple-900)] m-0">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[length:var(--gs-text-base)] text-[var(--gs-muted)] mt-1 mb-0">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------- Kpi

export function Kpi({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'positive' | 'warning';
}) {
  const valueColor =
    tone === 'positive'
      ? 'text-[var(--gs-success)]'
      : tone === 'warning'
        ? 'text-[var(--gs-warning)]'
        : 'text-[var(--gs-purple-900)]';
  return (
    <div
      /*
        O NÚMERO PRECISA CABER NO CARTÃO (rodada 56).

        Até a escala de tipo acordar, `text-[var(--gs-text-3xl)]` virava uma
        regra de COR inválida e o valor herdava os 15px do corpo: cabia em
        qualquer largura por acidente. Com os 36px aplicando de verdade, a
        faixa de quatro colunas do Painel dá ~180px de caixa e
        "R$ 128.430,55" pede 239px.

        E ele não se ajeita sozinho por dois motivos: `formatCents` separa o
        "R$" do número com espaço NÃO-SEPARÁVEL (U+00A0), então a string é uma
        palavra só e não quebra linha; e a grade usa `minmax(0, 1fr)`, então a
        coluna não cresce até o conteúdo. O resultado é o gestor lendo o
        faturamento com o último dígito coberto pelo cartão vizinho.

        `container-type` faz o `cqw` medir ESTE cartão, e o `clamp` deixa o
        número encolher até caber sem nunca passar dos 36px onde sobra espaço.
        Encolher é o único ajuste honesto: quebrar linha parte o valor no meio
        e cortar esconde dígito.
      */
      style={{ containerType: 'inline-size' }}
      className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] shadow-[var(--gs-shadow)] p-5"
    >
      <p className="text-[length:var(--gs-text-sm)] font-semibold uppercase tracking-wide text-[var(--gs-muted)] m-0">
        {label}
      </p>
      <p
        className={`font-bold mt-2 mb-0 ${valueColor}`}
        style={{ fontSize: 'clamp(1.125rem, 11cqw, var(--gs-text-3xl))' }}
      >
        {value}
      </p>
      {hint && <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-0">{hint}</p>}
    </div>
  );
}

// -------------------------------------------------------------------- Table

export function DataTable<T>({
  columns,
  rows,
  keyOf,
  empty,
}: {
  // O indice acompanha a linha: colunas que agem sobre a POSICAO do item (a
  // conferencia da nota, por exemplo) precisam dele, e deriva-lo por busca na
  // lista quebraria com dois itens iguais.
  columns: { header: string; render: (row: T, index: number) => ReactNode; align?: 'left' | 'right' }[];
  rows: T[];
  keyOf: (row: T) => string;
  empty?: ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    // O container rola sozinho para que a página nunca role na horizontal.
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[length:var(--gs-text-base)]">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.header}
                scope="col"
                className={`px-4 py-3 text-[length:var(--gs-text-sm)] font-semibold uppercase tracking-wide
                  text-[var(--gs-muted)] border-b border-[var(--gs-border)] whitespace-nowrap
                  ${col.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={keyOf(row)} className="hover:bg-[var(--gs-surface-hover)]">
              {columns.map((col) => (
                <td
                  key={col.header}
                  className={`px-4 py-3 border-b border-[var(--gs-border)]
                    ${col.align === 'right' ? 'text-right tabular-nums' : 'text-left'}`}
                >
                  {col.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Helpers de formatação vivem em `./format` — um módulo de componentes não
// deve exportar funções, sob pena de quebrar o fast refresh.
