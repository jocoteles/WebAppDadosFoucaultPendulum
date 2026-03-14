// script.js

// -----------------------------------------------------------------------------
// Configurações e Constantes Globais
// -----------------------------------------------------------------------------

// Configuração do Firebase carregada de config.js
// firebaseConfig e APP_CHECK_PUBLIC_KEY devem estar definidos globalmente.

// Parâmetros de Visualização e Comportamento
const THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR = 5.67; // Taxa de precessão teórica em graus por hora. Ajuste para sua latitude!
const MIN_POINTS_FOR_FIT = 3;                         // Mínimo de pontos para realizar um ajuste linear.
const INITIAL_VIEW_HOURS = 3;                         // Janela de visualização inicial preferencial em horas.
const MIN_POINTS_INITIAL_VIEW = 10;                   // Mínimo de pontos para mostrar na visualização inicial, se menos de INITIAL_VIEW_HOURS cobrir menos pontos.
const MAX_INITIAL_VIEW_POINTS = 200;                  // Máximo de pontos a mostrar na visualização inicial se "todos os pontos" for a opção. Evita sobrecarregar com muitos dados.
const ANGLE_DECIMAL_PLACES = 2;                       // Número de casas decimais para exibir ângulos.

// Elementos DOM
const precessionChartCtx = document.getElementById('precessionChart').getContext('2d');
const btnLinearFit = document.getElementById('btnLinearFit');
const btnExportData = document.getElementById('btnExportData');
const btnResetZoom = document.getElementById('btnResetZoom');
const btnToggleMod360 = document.getElementById('btnToggleMod360');
const currentPrecessionSpeedEl = document.getElementById('currentPrecessionSpeed');
const meanPrecessionSpeedEl = document.getElementById('meanPrecessionSpeed');
const stdDevPrecessionSpeedEl = document.getElementById('stdDevPrecessionSpeed');

// Variáveis Globais
let precessionChart;
let allDataPoints = [];      // Armazena todos os pontos {timestamp, angle, originalAngle}
let isFirstLoad = true;      // Para controlar a configuração inicial do zoom
let fitLinesActive = false; // Controla se as linhas de ajuste estão ativas/visíveis
let mod360ScaleActive = false; // Controla se a escala do eixo Y está em modo "pilhas de 360°"

// -----------------------------------------------------------------------------
// Inicialização do Firebase e App Check
// -----------------------------------------------------------------------------
let database;

if (typeof firebaseConfig !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    database = firebase.database();
} else {
    console.error("Firebase configuration not found. Please check config.js");
}

// -----------------------------------------------------------------------------
// Funções Utilitárias
// -----------------------------------------------------------------------------

/**
 * Converte timestamp (ms) para horas desde o início da era Unix.
 * @param {number} timestamp - Timestamp em segundos.
 * @returns {number} Tempo em horas.
 */
function timestampToHours(timestamp) {
    return timestamp / (1000 * 60 * 60);
}

/**
 * Normaliza um ângulo para o intervalo [0, 360) graus.
 * @param {number} angle - Ângulo em graus.
 * @returns {number} Ângulo normalizado.
 */
function normalizeAngle(angle) {
    return ((angle % 360) + 360) % 360;
}

/**
 * Calcula a regressão linear usando a biblioteca simple-statistics.
 * @param {Array<{x: number, y: number}>} points - Array de objetos com x (tempo em horas) e y (ângulo).
 * @returns {object|null} Objeto com slope (m), intercept (b), rSquared, e stdDevResiduals, ou null.
 *                        A biblioteca simple-statistics chama slope de 'm' e intercept de 'b'.
 */
function calculateLinearRegressionWithLib(points) {
    if (points.length < MIN_POINTS_FOR_FIT) return null;

    // Converte os pontos para o formato esperado pela biblioteca: [[x1, y1], [x2, y2], ...]
    const dataForLib = points.map(p => [p.x, p.y]);

    try {
        const linearRegression = ss.linearRegression(dataForLib); // { m: slope, b: intercept }
        const lineFunction = ss.linearRegressionLine(linearRegression); // y = mx + b

        // Calcular R² (coeficiente de determinação)
        const rSquared = ss.rSquared(dataForLib, lineFunction);

        // Calcular desvio padrão dos resíduos
        let sumSquaredErrors = 0;
        points.forEach(p => {
            const predictedY = lineFunction(p.x); // ou linearRegression.m * p.x + linearRegression.b
            sumSquaredErrors += Math.pow(p.y - predictedY, 2);
        });
        // A fórmula para o desvio padrão dos resíduos (ou erro padrão da regressão) é sqrt(SSE / (n - k - 1))
        // onde n é o número de pontos e k é o número de preditores (1 para regressão linear simples).
        // Então, graus de liberdade = n - 2.
        const n = points.length;
        const stdDevResiduals = n > MIN_POINTS_FOR_FIT ? Math.sqrt(sumSquaredErrors / (n - MIN_POINTS_FOR_FIT)) : 0;

        return {
            slope: linearRegression.m,
            intercept: linearRegression.b,
            rSquared: rSquared,
            stdDevResiduals: stdDevResiduals
        };
    } catch (error) {
        console.error("Erro ao calcular regressão linear com simple-statistics:", error);
        // Isso pode acontecer se, por exemplo, todos os valores de X forem iguais,
        // levando a uma divisão por zero internamente na biblioteca.
        return null;
    }
}

/**
 * Calcula a regressão linear para um conjunto de pontos.
 * @param {Array<{x: number, y: number}>} points - Array de objetos com propriedades x (tempo em horas) e y (ângulo).
 * @returns {object|null} Objeto com slope, intercept, rSquared, stdDevResiduals, ou null.
 */
function calculateLinearRegression(points) {
    if (points.length < MIN_POINTS_FOR_FIT) return null;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    const n = points.length;
    points.forEach(p => {
        sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; sumY2 += p.y * p.y;
    });

    const denominator = (n * sumX2 - sumX * sumX);
    if (Math.abs(denominator) < 1e-9) return null; // Evita divisão por zero se todos os X forem iguais

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    const rNumerator = (n * sumXY - sumX * sumY);
    const rDenominator = Math.sqrt(denominator * (n * sumY2 - sumY * sumY));
    const rSquared = rDenominator === 0 ? 1 : Math.pow(rNumerator / rDenominator, 2);

    let sumSquaredErrors = 0;
    points.forEach(p => {
        const predictedY = slope * p.x + intercept;
        sumSquaredErrors += Math.pow(p.y - predictedY, 2);
    });
    const stdDevResiduals = n > MIN_POINTS_FOR_FIT ? Math.sqrt(sumSquaredErrors / (n - MIN_POINTS_FOR_FIT)) : 0;
    return { slope, intercept, rSquared, stdDevResiduals };
}

// -----------------------------------------------------------------------------
// Funções do Gráfico e Interação
// -----------------------------------------------------------------------------

/**
 * Inicializa o gráfico de precessão com plugin de zoom.
 */
function initializeChart() {
    Chart.register(ChartZoom);

    // Rastrea a posição do mouse no canvas para o zoom dinâmico
    precessionChartCtx.canvas.addEventListener('mousemove', (e) => {
        // offsetX e offsetY pegam as coordenadas relativas exatas do canvas
        precessionChartCtx.canvas._mouseX = e.offsetX;
        precessionChartCtx.canvas._mouseY = e.offsetY;
    });

    // Função para determinar o modo de zoom com base na posição do mouse
    function getDynamicZoomMode({ chart }) {
        const x = chart.canvas._mouseX || 0;
        const y = chart.canvas._mouseY || 0;
        const chartArea = chart.chartArea;

        if (!chartArea) return 'xy'; // Prevenção caso chartArea ainda não exista

        // Eixo Y: Está na parte do canvas à esquerda da área de plotagem (chartArea.left)?
        if (x < chartArea.left) {
            return 'y';
        }

        // Eixo X: Está na parte do canvas abaixo da área de plotagem (chartArea.bottom)?
        if (y > chartArea.bottom) {
            return 'x';
        }

        // Se estiver dentro da área de plotagem (ou acima/à direita, o que seria área de legenda/título)
        return 'xy';
    }

    precessionChart = new Chart(precessionChartCtx, {
        type: 'scatter', // MUDANÇA: Para pontos sem linhas de conexão por padrão
        data: {
            datasets: [
                { // Dados Experimentais (índice 0)
                    label: 'Ângulo Observado (°)',
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.6)', // Cor dos pontos
                    data: [], // {x: timestamp, y: angle_mod_360}
                    pointRadius: 4,
                    showLine: false, // MUDANÇA: Não mostrar linha conectando os pontos
                    order: 2 // Ordem de desenho (mais alto = mais na frente)
                },
                { // Ajuste Linear (índice 1)
                    label: 'Ajuste Linear',
                    type: 'line', // Força este dataset a ser uma linha
                    borderColor: 'rgb(255, 99, 132)', // Vermelho
                    backgroundColor: 'rgba(255, 99, 132, 0.1)',
                    borderWidth: 2, // Linha contínua e um pouco mais grossa
                    data: [],
                    pointRadius: 0,
                    fill: false,
                    hidden: true,
                    order: 0 // Desenhar atrás de tudo
                },
                { // Precessão Teórica (índice 2)
                    label: `Precessão Teórica (${THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR.toFixed(2)}°/h)`,
                    type: 'line', // Força este dataset a ser uma linha
                    borderColor: 'rgb(54, 162, 235)', // Azul
                    borderWidth: 1.5, // Mais fina que o ajuste
                    borderDash: [5, 5], // Tracejada
                    data: [],
                    pointRadius: 0,
                    fill: false,
                    hidden: true,
                    order: 1 // Entre o ajuste e os dados
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        //unit: 'hour', // O Chart.js pode escolher unidades melhores (day, minute) dependendo do zoom
                        tooltipFormat: 'DD/MM/YYYY HH:mm:ss',
                        displayFormats: {
                            //millisecond: 'HH:mm:ss.SSS',
                            second: 'HH:mm:ss',
                            minute: 'HH:mm',
                            hour: 'HH:mm', // Formato para quando a unidade principal é hora
                            day: 'DD/MM',
                            week: 'DD/MM',
                            month: 'MMM YYYY',
                            quarter: '[Q]Q YYYY',
                            year: 'YYYY'
                        },
                    },
                    title: { display: true, text: 'Tempo' },
                    // O zoom/pan já deve ajustar a escala horizontal automaticamente
                },
                y: {
                    title: { display: true, text: 'Ângulo de Precessão (°)' },
                    ticks: {
                        callback: function (value) {
                            if (mod360ScaleActive) {
                                // Mostra o valor mod 360, sempre positivo
                                const modVal = ((value % 360) + 360) % 360;
                                return modVal.toFixed(0) + '°';
                            }
                            return value.toFixed(ANGLE_DECIMAL_PLACES);
                        }
                    }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                // Mostra o ângulo original no tooltip se disponível (para dados experimentais)
                                const originalDataPoint = allDataPoints.find(p => p.timestamp === context.parsed.x);
                                const angleToDisplay = (context.datasetIndex === 0 && originalDataPoint)
                                    ? originalDataPoint.originalAngle
                                    : context.parsed.y;
                                label += angleToDisplay.toFixed(ANGLE_DECIMAL_PLACES) + '°';
                            }
                            return label;
                        }
                    }
                },
                zoom: {
                    pan: {
                        enabled: true,
                        mode: getDynamicZoomMode,
                        onPanComplete: handleZoomPan
                    },
                    zoom: {
                        wheel: { enabled: true, speed: 0.1 },
                        pinch: { enabled: true },
                        mode: getDynamicZoomMode,
                        onZoomComplete: handleZoomPan
                    }
                }
            }
        },
        plugins: [{
            id: 'mod360BoundaryLines',
            afterDraw(chart) {
                if (!mod360ScaleActive) return;
                const yScale = chart.scales.y;
                const xScale = chart.scales.x;
                if (!yScale || !xScale) return;

                const ctx = chart.ctx;
                const yMin = yScale.min;
                const yMax = yScale.max;

                // Encontra os múltiplos de 360 dentro do range visível
                const firstBoundary = Math.ceil(yMin / 360) * 360;

                ctx.save();
                ctx.strokeStyle = 'rgba(180, 120, 255, 0.55)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);

                for (let boundary = firstBoundary; boundary <= yMax; boundary += 360) {
                    const yPixel = yScale.getPixelForValue(boundary);
                    ctx.beginPath();
                    ctx.moveTo(xScale.left, yPixel);
                    ctx.lineTo(xScale.right, yPixel);
                    ctx.stroke();

                    // Label indicando o número do ciclo (ex: "1×360°")
                    const cycleNum = Math.round(boundary / 360);
                    if (cycleNum > 0) {
                        ctx.save();
                        ctx.setLineDash([]);
                        ctx.fillStyle = 'rgba(150, 80, 220, 0.85)';
                        ctx.font = '10px sans-serif';
                        ctx.textAlign = 'right';
                        ctx.fillText(`${cycleNum}×360°`, xScale.left - 4, yPixel - 3);
                        ctx.restore();
                    }
                }
                ctx.restore();
            }
        }]
    });
}

/**
 * Obtém os dados de `allDataPoints` que estão atualmente visíveis no gráfico.
 * @returns {Array<{timestamp: number, angle: number, originalAngle: number}>} Array de pontos visíveis.
 */
function getVisibleChartData() {
    if (!precessionChart || !allDataPoints.length) return [];
    const { min: minVisibleTime, max: maxVisibleTime } = precessionChart.scales.x;
    return allDataPoints.filter(p => p.timestamp >= minVisibleTime && p.timestamp <= maxVisibleTime);
}


/**
 * Atualiza as linhas de ajuste linear e teórica se estiverem ativas.
 * É chamada após zoom/pan ou quando novos dados chegam e o ajuste está ativo.
 */
function updateFitLinesIfActive() {
    if (!precessionChart || !fitLinesActive) { // Verifica a flag global
        // Se não estiverem ativas, garante que estejam escondidas
        if (precessionChart) {
            precessionChart.data.datasets[1].hidden = true;
            precessionChart.data.datasets[1].data = [];
            precessionChart.data.datasets[2].hidden = true;
            precessionChart.data.datasets[2].data = [];
            precessionChart.update('none');
        }
        return;
    }

    const visibleData = getVisibleChartData();
    if (visibleData.length < MIN_POINTS_FOR_FIT) {
        precessionChart.data.datasets[1].data = [];
        precessionChart.data.datasets[2].data = [];
        precessionChart.update('none');
        return;
    }

    // Para o ajuste, usar os ângulos originais (não módulo 360) para um ajuste linear contínuo
    const pointsForFit = visibleData.map(p => ({
        x: timestampToHours(p.timestamp), // Tempo em HORAS
        y: p.originalAngle // Ângulo original (não módulo 360)
    }));
    const fit = calculateLinearRegressionWithLib(pointsForFit);

    if (fit) {
        // Linha de Ajuste Linear
        const firstVisibleTimeHours = timestampToHours(visibleData[0].timestamp);
        const lastVisibleTimeHours = timestampToHours(visibleData[visibleData.length - 1].timestamp);

        precessionChart.data.datasets[1].data = [
            { x: visibleData[0].timestamp, y: fit.slope * firstVisibleTimeHours + fit.intercept },
            { x: visibleData[visibleData.length - 1].timestamp, y: fit.slope * lastVisibleTimeHours + fit.intercept }
        ];
        precessionChart.data.datasets[1].hidden = false;


        // Linha Teórica
        // 1. Calcular o tempo médio e o ângulo original médio dos dados visíveis
        let sumVisibleTimeHours = 0;
        let sumVisibleOriginalAngle = 0;
        visibleData.forEach(p => {
            sumVisibleTimeHours += timestampToHours(p.timestamp);
            sumVisibleOriginalAngle += p.originalAngle;
        });
        const meanVisibleTimeHours = sumVisibleTimeHours / visibleData.length;
        const meanVisibleOriginalAngle = sumVisibleOriginalAngle / visibleData.length;

        // 2. A linha teórica passará por (meanVisibleTimeHours, meanVisibleOriginalAngle) com a inclinação teórica
        const interceptTheoretical = meanVisibleOriginalAngle - THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR * meanVisibleTimeHours;

        precessionChart.data.datasets[2].data = [
            { x: visibleData[0].timestamp, y: THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR * firstVisibleTimeHours + interceptTheoretical },
            { x: visibleData[visibleData.length - 1].timestamp, y: THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR * lastVisibleTimeHours + interceptTheoretical }
        ];
        precessionChart.data.datasets[2].hidden = false;

    } else {
        precessionChart.data.datasets[1].data = [];
        precessionChart.data.datasets[2].data = [];
    }
    precessionChart.update('none');
}


/**
 * Chamado após uma interação de zoom ou pan.
 */
function handleZoomPan() {
    // A escala X é atualizada automaticamente pelo Chart.js e pelo plugin de zoom.
    // A escala Y é fixa (0-360).
    //updateFitLinesIfActive(); // Atualiza as linhas de ajuste com base nos novos dados visíveis
}

/**
 * Realiza o ajuste linear nos dados VISÍVEIS e atualiza o gráfico e estatísticas.
 */
function performAndDisplayLinearFit() {
    if (!precessionChart) return;

    const visibleData = getVisibleChartData();

    if (visibleData.length < MIN_POINTS_FOR_FIT) {
        alert(`São necessários pelo menos ${MIN_POINTS_FOR_FIT} pontos na janela de visualização para o ajuste linear.`);
        meanPrecessionSpeedEl.textContent = "- N/A -";
        stdDevPrecessionSpeedEl.textContent = "- N/A -";
        precessionChart.data.datasets[1].data = [];
        precessionChart.data.datasets[1].hidden = true;
        precessionChart.data.datasets[2].data = [];
        precessionChart.data.datasets[2].hidden = true;
        fitLinesActive = false;
        precessionChart.update();
        return;
    }

    // Usar ângulos originais para o cálculo do ajuste linear
    const pointsForFit = visibleData.map(p => ({
        x: timestampToHours(p.timestamp), // Tempo em HORAS
        y: p.originalAngle
    }));
    console.log("Dados para ajuste linear:", JSON.stringify(pointsForFit));
    const fit = calculateLinearRegressionWithLib(pointsForFit);

    if (fit) {
        meanPrecessionSpeedEl.textContent = `${fit.slope.toFixed(3)} °/hora (R²=${fit.rSquared.toFixed(3)})`;
        stdDevPrecessionSpeedEl.textContent = `${fit.stdDevResiduals.toFixed(ANGLE_DECIMAL_PLACES)} °`;
        fitLinesActive = true;
        updateFitLinesIfActive();
    } else {
        meanPrecessionSpeedEl.textContent = "- N/A -";
        stdDevPrecessionSpeedEl.textContent = "- N/A -";
        precessionChart.data.datasets[1].data = [];
        precessionChart.data.datasets[1].hidden = true;
        precessionChart.data.datasets[2].data = [];
        precessionChart.data.datasets[2].hidden = true;
        fitLinesActive = false;
    }
    precessionChart.update(); // Update principal após o clique no botão
}

/**
 * Exporta os dados atualmente visíveis no gráfico para um arquivo CSV.
 */
function exportVisibleDataToCSV() {
    const visibleData = getVisibleChartData();
    if (visibleData.length === 0) {
        alert("Não há dados visíveis para exportar.");
        return;
    }
    // Exporta o ângulo módulo 360 e o original
    let csvContent = "data:text/csv;charset=utf-8,Timestamp (ms),Data Hora,Angulo Mod360 (°),Angulo Original (°)\n";
    visibleData.forEach(p => {
        const dateTimeString = moment(p.timestamp).format('YYYY-MM-DD HH:mm:ss');
        csvContent += `${p.timestamp},${dateTimeString},${p.angle.toFixed(ANGLE_DECIMAL_PLACES)},${p.originalAngle.toFixed(ANGLE_DECIMAL_PLACES)}\n`;
    });
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    const timestampStr = moment().format('YYYYMMDD_HHmmss');
    link.setAttribute("download", `precessao_pendulo_visivel_${timestampStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Processa a atualização de dados (novos dados do Firebase).
 */
function processDataUpdate() {
    if (!precessionChart) return;

    // Mapeia os dados para o gráfico, normalizando o ângulo e guardando o original
    const chartDisplayData = allDataPoints.map(p => ({
        x: p.timestamp,
        y: p.originalAngle // ângulo bruto, sem módulo 360
    }));
    precessionChart.data.datasets[0].data = chartDisplayData;

    // Calcula velocidade atual com os dois últimos pontos de allDataPoints (usando ângulos originais)
    if (allDataPoints.length >= 2) {
        const lastPoint = allDataPoints[allDataPoints.length - 1];
        const secondLastPoint = allDataPoints[allDataPoints.length - 2];
        const deltaTimeHours = (lastPoint.timestamp - secondLastPoint.timestamp) / (1000 * 60 * 60);
        if (deltaTimeHours > 0) {
            const deltaAngle = lastPoint.originalAngle - secondLastPoint.originalAngle; // Usa originalAngle
            const currentSpeed = deltaAngle / deltaTimeHours;
            currentPrecessionSpeedEl.textContent = `${currentSpeed.toFixed(2)} °/hora`;
        } else {
            currentPrecessionSpeedEl.textContent = `- N/A -`;
        }
    } else {
        currentPrecessionSpeedEl.textContent = `- N/A -`;
    }

    // Define a janela de zoom inicial para o eixo X
    if (isFirstLoad && allDataPoints.length > 0) {
        let initialMinTimestamp;
        let initialMaxTimestamp = allDataPoints[allDataPoints.length - 1].timestamp; // Último ponto

        if (allDataPoints.length === 1) {
            // Se houver apenas um ponto, crie uma pequena janela ao redor dele
            initialMinTimestamp = allDataPoints[0].timestamp - (1 * 1000 * 60 * 60); // 1 hora antes
            initialMaxTimestamp = allDataPoints[0].timestamp + (1 * 1000 * 60 * 60); // 1 hora depois
        } else {
            // Lógica existente para 3 horas ou todos os pontos limitados
            const threeHoursAgo = initialMaxTimestamp - (INITIAL_VIEW_HOURS * 1000 * 60 * 60);
            const firstPointOverallTimestamp = allDataPoints[0].timestamp;

            if (threeHoursAgo < firstPointOverallTimestamp || allDataPoints.length < MIN_POINTS_INITIAL_VIEW) {
                const startIndex = Math.max(0, allDataPoints.length - MAX_INITIAL_VIEW_POINTS);
                initialMinTimestamp = allDataPoints[startIndex].timestamp;
            } else {
                initialMinTimestamp = threeHoursAgo;
            }
        }

        // Aplica ao gráfico diretamente, o Chart.js irá pegar nas opções do Chart
        precessionChart.options.scales.x.min = initialMinTimestamp;
        precessionChart.options.scales.x.max = initialMaxTimestamp;

        isFirstLoad = false;
    } else if (isFirstLoad && allDataPoints.length === 0) {
        // Se não houver dados na primeira carga, limpe min/max para que o Chart.js não tente usar valores antigos
        delete precessionChart.options.scales.x.min;
        delete precessionChart.options.scales.x.max;
        isFirstLoad = false; // Ainda considera a primeira carga "tratada"
    }


    //updateFitLinesIfActive();
    precessionChart.update(); // Atualiza o gráfico
}

// -----------------------------------------------------------------------------
// Listeners de Eventos e Busca de Dados
// -----------------------------------------------------------------------------

btnLinearFit.addEventListener('click', performAndDisplayLinearFit);
btnExportData.addEventListener('click', exportVisibleDataToCSV);
btnToggleMod360.addEventListener('click', () => {
    mod360ScaleActive = !mod360ScaleActive;
    btnToggleMod360.textContent = mod360ScaleActive
        ? 'Desabilitar Mod 360° (Escala)'
        : 'Habilitar Mod 360° (Escala)';
    btnToggleMod360.classList.toggle('active', mod360ScaleActive);
    if (precessionChart) {
        precessionChart.update();
    }
});
btnResetZoom.addEventListener('click', () => {
    if (precessionChart) {
        isFirstLoad = true; // Força recálculo da janela inicial na próxima atualização de dados
        // Se não houver novos dados chegando, o processDataUpdate pode não redefinir o zoom.
        // Então, forçamos uma redefinição de zoom aqui e depois chamamos processDataUpdate.
        precessionChart.resetZoom('none'); // Reseta o zoom sem animação
        processDataUpdate(); // Redesenha com a janela inicial
    }
});

const dataRef = database.ref('pendulum_sensor_data').orderByChild('timestamp');

dataRef.on('value', (snapshot) => {
    console.log("Novos dados recebidos do Firebase!"); // Log para verificar atualização
    const tempData = [];
    let lastUnwrappedAngle = null;
    snapshot.forEach((childSnapshot) => {
        const data = childSnapshot.val();
        if (data && typeof data.timestamp === 'number' && typeof data.angle_degrees === 'number') {
            let currentRawAngle = data.angle_degrees;
            let correctedAngle = currentRawAngle;

            if (lastUnwrappedAngle !== null) {
                // Lógica de "Unwrap": y = x - 360 * round((x - y_prev) / 360)
                // Isso encontra o múltiplo de 360 que torna o dado atual o mais próximo possível do anterior.
                correctedAngle = currentRawAngle - 360 * Math.round((currentRawAngle - lastUnwrappedAngle) / 360);
            }
            lastUnwrappedAngle = correctedAngle;

            tempData.push({
                timestamp: data.timestamp * 1000, // Converte para milisegundos
                originalAngle: correctedAngle,    // Agora armazena o ângulo corrigido para o gráfico/ajuste
                angle: normalizeAngle(currentRawAngle) // Mantém o ângulo módulo 360 (ex: para radar ou bússola, se houver)
            });
        }
    });
    // Ordena por timestamp (Firebase geralmente já faz isso com orderByChild, mas é uma garantia)
    allDataPoints = tempData.sort((a, b) => a.timestamp - b.timestamp);
    processDataUpdate();
}, (error) => {
    console.error("Erro ao buscar dados do Firebase:", error);
    alert("Não foi possível carregar os dados da precessão.");
});

// -----------------------------------------------------------------------------
// Inicialização
// -----------------------------------------------------------------------------
window.onload = () => {
    initializeChart();
};