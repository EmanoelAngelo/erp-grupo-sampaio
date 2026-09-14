/**
 * O endereço público do sistema — num módulo folha, de propósito.
 *
 * Ele morava no `PrintRenderer`, que era o único a precisar dele. A rodada 54
 * tirou a ordem de serviço de lá (`ServiceOrderA4`), e o A4 também precisa do
 * endereço para o QR — o que fechou um CICLO de importação: o renderizador
 * importava o documento e o documento importava o renderizador. Em ESM o ciclo
 * não estoura na hora: ele deixa uma das constantes do outro lado ainda vazia,
 * e o erro aparece longe, como "ORDER_STATUSES_ON_BENCH is not iterable" num
 * teste de e-mail que não tem nada a ver com impressão.
 *
 * Aqui não há importação nenhuma, e por isso ninguém pode fechar ciclo com
 * este arquivo.
 */

/**
 * Endereço público que o QR aponta.
 *
 * Sai da configuração, não do host da requisição: a plaquinha é impressa uma
 * vez e fica colada no equipamento por anos. Se apontasse para o IP da máquina
 * que imprimiu, o QR pararia de funcionar assim que a rede mudasse.
 */
export function publicBaseUrl(): string {
  const configurado = (process.env.GRUPO_SAMPAIO_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  return configurado || 'https://grupossampaio.com.br';
}

/**
 * O endereço público está mesmo configurado?
 *
 * `GRUPO_SAMPAIO_PUBLIC_URL` está declarada nos arquivos de ambiente e no
 * schema de `config/env.ts`, que recusa um valor sem `http://` ou `https://`.
 * Declarada não é o mesmo que preenchida: em branco, o QR sai apontando para o
 * literal de reserva. Por isso esta função existe separada — a tela que gera a
 * folha mostra o endereço e avisa antes de imprimir. Uma plaquinha errada só é
 * descoberta quando um cliente tenta escanear, e aí ela já está colada.
 */
export function publicBaseUrlConfigurada(): boolean {
  return Boolean((process.env.GRUPO_SAMPAIO_PUBLIC_URL ?? '').trim());
}
