/**
 * A AC RAIZ BRASILEIRA v10 — o certificado público do ITI (rodada 60).
 *
 * ============================================================================
 * POR QUE ELE É UMA CONSTANTE, E NÃO UM ARQUIVO .pem AO LADO
 * ============================================================================
 *
 * Porque o servidor de produção roda de dist/, e o tsc compila .ts — não copia
 * .pem. Um arquivo ao lado funciona no desenvolvimento, some no build, e a
 * emissão fiscal inteira cai com "arquivo não encontrado" no primeiro dia de
 * produção. É o defeito que passa em toda a suíte verde e só aparece onde
 * ninguém quer descobrir.
 *
 * Como constante, o certificado é COMPILADO junto: viaja no bundle, no
 * contêiner, em qualquer empacotamento, sem passo de build para alguém
 * esquecer.
 *
 * ============================================================================
 * O QUE É ESTE BLOCO
 * ============================================================================
 *
 * O certificado PÚBLICO da Autoridade Certificadora Raiz Brasileira v10,
 * emitida pelo Instituto Nacional de Tecnologia da Informação (ITI). É o
 * mesmo que todo navegador carrega — público por definição, não é segredo de
 * ninguém —, extraído do truststore do sistema operacional e conferido por
 * titular, emissor e validade no teste ao lado.
 *
 * Válido de 2019-07-01 a 2032-07-01.
 */
export const RAIZ_BRASILEIRA_V10_PEM = "-----BEGIN CERTIFICATE-----\nMIIGrDCCBJSgAwIBAgIJANLVi0S/gZNCMA0GCSqGSIb3DQEBDQUAMIGYMQswCQYDVQQGEwJCUjET\nMBEGA1UECgwKSUNQLUJyYXNpbDE9MDsGA1UECww0SW5zdGl0dXRvIE5hY2lvbmFsIGRlIFRlY25v\nbG9naWEgZGEgSW5mb3JtYWNhbyAtIElUSTE1MDMGA1UEAwwsQXV0b3JpZGFkZSBDZXJ0aWZpY2Fk\nb3JhIFJhaXogQnJhc2lsZWlyYSB2MTAwHhcNMTkwNzAxMTkxNTU5WhcNMzIwNzAxMTIwMDU5WjCB\nmDELMAkGA1UEBhMCQlIxEzARBgNVBAoMCklDUC1CcmFzaWwxPTA7BgNVBAsMNEluc3RpdHV0byBO\nYWNpb25hbCBkZSBUZWNub2xvZ2lhIGRhIEluZm9ybWFjYW8gLSBJVEkxNTAzBgNVBAMMLEF1dG9y\naWRhZGUgQ2VydGlmaWNhZG9yYSBSYWl6IEJyYXNpbGVpcmEgdjEwMIICIjANBgkqhkiG9w0BAQEF\nAAOCAg8AMIICCgKCAgEAk3AxKl1ZtP0pNyjChqO7qNkn+/sClZeqiV/Kd7KnnbkDbI2y3VWcUG7f\neCE/deIxot6GH6JXncRG794UZl+4doD0D0/cEwBd4DvrDSZm0RT40xhmYYOTxZDJxv+coTHdmsT5\naNmSkktfjzYX4HQHh/7Mem+kTOpT/3E4K6B7KVs9HkOT7nXx5yU1qYbVWqI0qpJM9mOTSFx8C9Hi\nKcHvLCvt1ioXKPAmFuHPkayOcXP2MXeb+VRNjWKU4E+L2t5uZPKVx1M/9i1DztlLb4K8OfYgGaPD\nUSF1sxnoGk5qZHLleO6KjCpmuQepmgsBvxi2YNO7X2YUwQQx1AXNSolgtkAR5gt+1WzxhbFUhItQ\nqlhqxgWHefLmiT5T/Ctz/P2v+zSO4efkkIzsi1iwD+ypZvM2lnIvB24RcSN6jzmCahLPX4CwjwIK\n6JsSoMVxIhpZHCguUP4LXqP8IWUZ6WgS/4zB7B9E0EICl2rM1PRy+6ulv+ZOW256e8a0pijUB+hX\nM1msUq9L92476FAAX8va3sP7+Uut94+bGHmubcTLImWUPrxNT7QyrvE3FyHicfiHioeFL2oV4cXT\nLZrEq2wS8R4PKPdSzNn5Z9e2uMEGYQaSNO+OwvVycpIhOBOqrm12wJ9ZhWKtM5UOo34/o37r5ZBI\nTYXAGbhqQDB9mWXwH+0CAwEAAaOB9jCB8zBOBgNVHSAERzBFMEMGBWBMAQEAMDowOAYIKwYBBQUH\nAgEWLGh0dHA6Ly9hY3JhaXouaWNwYnJhc2lsLmdvdi5ici9EUENhY3JhaXoucGRmMEAGA1UdHwQ5\nMDcwNaAzoDGGL2h0dHA6Ly9hY3JhaXouaWNwYnJhc2lsLmdvdi5ici9MQ1JhY3JhaXp2MTAuY3Js\nMB8GA1UdIwQYMBaAFHTzfv/8n1N68Xzrqz6kptoYukVjMB0GA1UdDgQWBBR0837//J9TevF866s+\npKbaGLpFYzAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQ0FAAOC\nAgEAeCNhBSuy/Ih/T+1VOtAJju85SrtoE3vET1qXASpmjQllDHG/ph7VFNRAkC+gha+BCbjoA5oJ\n/8wwl+Qdp1KGz6nXXFTLx3osU+kjm0srmBf9nyXHPqvFyvBeB0A7sYb7TmII9GKD20oCxsdkccR/\noE/JuTaNnGq0GYZ2aDb5v62uLi21Y6P9UBiTxZqQ4ojWET6kXNjlK238jpXv17FR8Sg3VusCvX7Q\n8eJkavvHHZDeWck2fSA+ycAc2JeL2Z0BMSxGWpH32WM9J8+6XqCJUXHiWEV0zCE8wDYiYC+047pT\nxQI/gB/FcU7jvylh98DJkQPHd/Tp6Og3ynlDA9n9uBbxYHVRZs9vsZ/7xTFaxRe+zk8dhgKgZ/3R\nrcMFB5702t8LFbyuUE/kQVY6rZ0QJ9qMWQ7VPLRwRhiMeU3k8WDJb/tBbOXHBqldTbWyQ+mpMEDW\nhbrzE/IED82wAuO23Tb05cYk2xC7+Izef8fSc3XdJDuPSbcDpWukzyCDtSEHisLiGEtIbYRiPsF3\nczlQPsnIEVoTTCWxHCH1zYR6zScSv18Qh69qVe2J40K5jZoPGEOhq/oKhVJQAdvAFW5Odp7mF3Tk\n9nivjjsctJSxY26LFiV5GRV+07SSse4ti0aOjO5PLg5SWjfcOtBG2rz02EIvQAmLcb0kGBtfdj0l\nW/w=\n-----END CERTIFICATE-----\n";
