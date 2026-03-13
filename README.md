# Pêndulo de Foucault: Visualização Web de Dados

Esta é a interface web do Pêndulo de Foucault do CCA/UFSCar. Esta aplicação foi desenvolvida para permitir a visualização em tempo real e a análise do comportamento do plano de oscilação do pêndulo. 

O Pêndulo de Foucault demonstra a rotação da Terra observando como o seu plano de oscilação rotaciona lentamente ao longo do tempo (precessão). Neste projeto, uma câmera em uma Raspberry Pi captura o movimento do pêndulo e envia os dados continuamente para um banco de dados no Firebase. Esta aplicação web lê esses dados e constrói um gráfico interativo mostrando a evolução desse ângulo ao longo do tempo.

Além de apenas observar, a aplicação permite que qualquer pessoa interessada faça uma análise dos dados, podendo traçar a reta teórica de precessão projetada para a localidade de Araras-SP e um ajuste linear sobre os dados coletados para fins de comparação.

## Funcionalidades da Aplicação

*   **Gráfico Interativo:** Visualização em tempo real do ângulo de precessão versus tempo. O gráfico suporta *zoom* e *pan* (arrastar), otimizando a visualização para longos períodos de tempo.
*   **Escala em Pilhas de 360° (Mod 360°):** Um botão de alternância permite mudar a visualização do eixo vertical entre dois modos, sem alterar a posição dos dados no gráfico:
    *   **Desabilitado (padrão):** O eixo Y exibe o ângulo acumulado real (ex.: 361°, 722°, 1083°...), ideal para verificar a tendência linear da precessão ao longo do tempo.
    *   **Habilitado:** O eixo Y exibe a escala de forma cíclica — os *labels* são apresentados em módulo 360° (de 0° a 360°, repetindo-se), de maneira análoga a um papel semilog, porém com espaçamento linear. Linhas divisórias tracejadas são adicionadas automaticamente a cada múltiplo de 360° para facilitar a leitura dos ciclos completos.
*   **Ajuste Linear Estatístico:** É possível realizar uma regressão linear sobre os dados que estão visíveis na tela no momento, calculando a velocidade média de precessão experimental.
*   **Comparação Teórica:** A aplicação sobrepõe aos dados reais uma reta representando a velocidade teórica esperada da precessão para a localidade de Araras-SP.
*   **Painel de Informações:** Exibição da velocidade instantânea do pêndulo e estatísticas básicas de desvio do experimento.
*   **Exportação de Dados:** Os usuários podem baixar a parte visível do gráfico em formato `.csv` para análises mais aprofundadas em softwares de planilhas locais.

---

## Guia de Implementação e Deploy Seguro

Para publicar esta aplicação no **GitHub Pages** de maneira segura, evitando expor chaves de acesso vulneráveis do Firebase em repositórios públicos, este projeto foi reestruturado para utilizar um sistema de injeção de segredos via **GitHub Actions**.

A seguir, estão os passos técnicos para rodar a aplicação localmente e publicá-la gratuitamente usando GitHub Pages.

### Pré-requisitos
1. Um projeto no Firebase com o Realtime Database ativado.
2. Suas credenciais do Firebase (`firebaseConfig`).
3. Uma conta no GitHub.

## Fase 1: Configuração Local (Desenvolvimento)

Para rodar a aplicação em seu próprio computador:

1.  **Clone o repositório** para a sua máquina.
2.  **Crie a Configuração Local**:
    *   Procure o arquivo `config.example.js` na raiz da pasta web.
    *   Faça uma cópia deste arquivo e renomeie-o para **`config.js`**. (O arquivo `.gitignore` do repositório está programado para esconder arquivos chamados `config.js` do GitHub).
    *   No GitHub, este arquivo não existirá, protegendo a sua chave.
3.  **Insira suas Chaves**:
    *   Abra o seu novo arquivo recém-criado `config.js` em um editor de texto.
    *   Cole as informações originadas do seu Firebase Console nos locais indicados (`apiKey`, `databaseURL`, etc).
4.  **Teste Localmente**:
    *   Abra o arquivo `index.html` ou sirva a pasta com uma extensão de Live Server (do VSCode, por exemplo) ou com Python (`python -m http.server`). O gráfico já deverá carregar e ler os dados.

## Fase 2: Configuração do GitHub Secrets

Como o arquivo `config.js` é intencionalmente retido no seu computador e ignorado pelo controle de versão do Git, nós precisamos sinalizar essas senhas para os servidores do GitHub apenas no exato momento da publicação do site. Isso é feito pelos **Secrets**.

1. Vá para a página inicial do seu repositório no GitHub.
2. Acesse a aba superior **Settings**.
3. No menu à esquerda, encontre a seção de **Security** e em seguida selecione **Secrets and variables > Actions**.
4. Você encontrará um botão verde chamado **New repository secret**. Você deve criar manualmente cada um dos segredos do Firebase listados abaixo, copiando os respectivos valores de dentro das aspas do seu `config.js` (como por exemplo, sua `apiKey` autêntica):
    *   `FIREBASE_API_KEY`
    *   `FIREBASE_AUTH_DOMAIN`
    *   `FIREBASE_DATABASE_URL`
    *   `FIREBASE_PROJECT_ID`
    *   `FIREBASE_STORAGE_BUCKET`
    *   `FIREBASE_MESSAGING_SENDER_ID`
    *   `FIREBASE_APP_ID`
    *   `APP_CHECK_PUBLIC_KEY`

Ao fim deste processo, o GitHub guardará suas senhas encriptadas de forma intransferível.

## Fase 3: Publicação Automática (GitHub Actions)

Com as chaves de segurança salvas, o processo de subir no ar usa um pequeno roteiro automático de automação.

1.  O repositório inclui uma pasta oculta chamada `.github/workflows/`. Dentro dela existe o arquivo `static.yml`.
2.  **Fazendo o Deploy:** Sempre que você enviar novas atualizações ao repositório (com um `git push origin master`), o GitHub Action lerá automaticamente o arquivo `.yml`.
3.  O Action injeta seus Secrets recriando uma versão efêmera do ficheiro `config.js` na memória do servidor e então publica todo o conjunto para o seu [usuário].github.io. 
4.  Para conferir o sucesso do processo, verifique a aba superior **Actions** no seu repositório do GitHub e analise se os sinais estão todos aparecendo com o *check* de aprovação em tons verdes.

## Fase 4: Otimização de Segurança no Firebase

Apenas ocultar a chave com o Actions protege a chave do público geral que lê o seu repositório. Porém, a visualização via web exige que seu navegador leia estas chaves na hora de se conectar (que é o padrão Firebase). Alguém com conhecimentos de inspeção local de página ainda saberia vê-las. Para resolver isto definivamente:

1.  **Regras do Database (Firebase Console):**
    É preciso definir rigorosamente dentro da tela "Realtime Database" -> "Rules" que qualquer parte da internet pode apenas LER, mas nunca modificar seu banco. Exemplo básico:
    ```json
    {
      "rules": {
        "pendulum_sensor_data": {
          ".read": true,
          "$data_id": {
            ".write": "newData.hasChild('secret_token') && newData.child('secret_token').val() === 'SEU_TOKEN_SECRETO' && !data.exists() && newData.hasChildren(['timestamp', 'angle_degrees'])",
            ".validate": "newData.hasChildren(['timestamp', 'angle_degrees', 'secret_token']) && newData.child('timestamp').isNumber() && newData.child('angle_degrees').isNumber() && newData.child('secret_token').isString()"
          }
        },
        "web_config": {
          ".read": true,
          ".write": false
        }
      }
    }
    ```
    *(Nota: Cuidado para não expor o `secret_token` real da Raspberry Pi no README de repositórios públicos. O exemplo acima usa um placeholder).*
2.  **Restringir Domínios da API Key (Google Cloud):**
    Este é o truque de ouro. Qualquer pessoa no mundo ainda pode invocar sua string da API Key e usar o "plano restrito" em sites maliciosos. O segredo final é informar ao Google que essa chave exata SÓ vale no seu domínio GitHub.
    *   Visite o painel central do seu Google Cloud Console, associe e selecione o projeto do Firebase que você criou em seguida.
    *   Vá a aba esqueda APIs e Serviços -> Credenciais.
    *   Toque no título nomeado de "Browser key (auto created by Firebase)".
    *   Selecione "Restrições de aplicativo -> Websites (referenciadores HTTP)". 
    *   Adicione tanto o domínio final do github (ex: `https://seu-usuario.github.io/*`) quanto o local para uso futuro (`http://localhost:*/*`). Salve em seguida.