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
const btnMod180 = document.getElementById('btnMod180');
const btnMod360 = document.getElementById('btnMod360');
const btnToggleContinuity = document.getElementById('btnToggleContinuity');
const currentPrecessionSpeedEl = document.getElementById('currentPrecessionSpeed');
const meanPrecessionSpeedEl = document.getElementById('meanPrecessionSpeed');
const stdDevPrecessionSpeedEl = document.getElementById('stdDevPrecessionSpeed');

// Variáveis Globais
let precessionChart;
let allDataPoints = [];          // Armazena todos os pontos {timestamp, angle180, angle360}
let isFirstLoad = true;          // Para controlar a configuração inicial do zoom
let fitLinesActive = false;      // Controla se as linhas de ajuste estão ativas/visíveis
let currentModMode = 180;        // Modo padrão: 180° (opção: 360°)
let continuityEnabled = true;    // Offset interno de visualização ativo por padrão (sem dente de serra)

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

    const n = points.length;
    // Deslocar X para o primeiro ponto para melhorar a estabilidade numérica
    const x0 = points[0].x;
    const dataForLib = points.map(p => [p.x - x0, p.y]);

    try {
        const linearRegression = ss.linearRegression(dataForLib); // { m: slope, b: intercept_shifted }
        const lineFunctionShifted = ss.linearRegressionLine(linearRegression);

        let sumSquaredErrors = 0;
        let sumX = 0;
        let sumX2 = 0;
        
        points.forEach(p => {
            const dx = p.x - x0;
            const predictedY = lineFunctionShifted(dx);
            sumSquaredErrors += Math.pow(p.y - predictedY, 2);
            sumX += dx;
            sumX2 += dx * dx;
        });

        // Graus de liberdade para regressão linear simples (y = mx + b) é n - 2
        const stdDevResiduals = n > 2 ? Math.sqrt(sumSquaredErrors / (n - 2)) : 0;

        // Erro padrão da inclinação (slope error)
        // SE_slope = stdDevResiduals / sqrt(sum((xi - meanX)^2))
        // sum((xi - meanX)^2) = sum(xi^2) - (sum(xi)^2 / n)
        const sumSquaredDeviationsX = sumX2 - (Math.pow(sumX, 2) / n);
        const slopeError = (n > 2 && sumSquaredDeviationsX > 0) 
            ? stdDevResiduals / Math.sqrt(sumSquaredDeviationsX) 
            : 0;

        return {
            slope: linearRegression.m,
            intercept: linearRegression.b - linearRegression.m * x0, // Intercepto original no x=0
            rSquared: ss.rSquared(dataForLib, lineFunctionShifted),
            stdDevResiduals: stdDevResiduals,
            slopeError: slopeError
        };
    } catch (error) {
        console.error("Erro ao calcular regressão linear com simple-statistics:", error);
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
    
    const n = points.length;
    const x0 = points[0].x;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    
    points.forEach(p => {
        const dx = p.x - x0;
        sumX += dx; sumY += p.y; sumXY += dx * p.y; sumX2 += dx * dx; sumY2 += p.y * p.y;
    });

    const denominator = (n * sumX2 - sumX * sumX);
    if (Math.abs(denominator) < 1e-9) return null;

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const interceptShifted = (sumY - slope * sumX) / n;
    const intercept = interceptShifted - slope * x0;

    const rNumerator = (n * sumXY - sumX * sumY);
    const rDenominator = Math.sqrt(denominator * (n * sumY2 - sumY * sumY));
    const rSquared = rDenominator === 0 ? 1 : Math.pow(rNumerator / rDenominator, 2);

    let sumSquaredErrors = 0;
    points.forEach(p => {
        const dx = p.x - x0;
        const predictedY = slope * dx + interceptShifted;
        sumSquaredErrors += Math.pow(p.y - predictedY, 2);
    });

    const stdDevResiduals = n > 2 ? Math.sqrt(sumSquaredErrors / (n - 2)) : 0;
    const sumSquaredDeviationsX = sumX2 - (Math.pow(sumX, 2) / n);
    const slopeError = (n > 2 && sumSquaredDeviationsX > 0) 
        ? stdDevResiduals / Math.sqrt(sumSquaredDeviationsX) 
        : 0;

    return { slope, intercept, rSquared, stdDevResiduals, slopeError };
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
                    title: { display: true, text: 'Ângulo de Precessão (Mod 180°)' },
                    ticks: {
                        callback: function (value) {
                            const mod = currentModMode;
                            const modVal = ((value % mod) + mod) % mod;
                            if (modVal === 0 && value > 0 && value <= mod) {
                                return mod + '°';
                            }
                            return modVal.toFixed(0) + '°';
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
                                if (context.datasetIndex === 0) {
                                    const originalDataPoint = allDataPoints.find(p => p.timestamp === context.parsed.x);
                                    if (originalDataPoint) {
                                        const val = currentModMode === 180 ? originalDataPoint.angle180 : originalDataPoint.angle360;
                                        label += val.toFixed(ANGLE_DECIMAL_PLACES) + '°';
                                    } else {
                                        const mod = currentModMode;
                                        const val = ((context.parsed.y % mod) + mod) % mod;
                                        label += val.toFixed(ANGLE_DECIMAL_PLACES) + '°';
                                    }
                                } else {
                                    const mod = currentModMode;
                                    const val = ((context.parsed.y % mod) + mod) % mod;
                                    label += val.toFixed(ANGLE_DECIMAL_PLACES) + '°';
                                }
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
            id: 'modBoundaryLines',
            afterDraw(chart) {
                if (!continuityEnabled) return;
                const yScale = chart.scales.y;
                const xScale = chart.scales.x;
                if (!yScale || !xScale) return;

                const step = currentModMode;
                const ctx = chart.ctx;
                const yMin = yScale.min;
                const yMax = yScale.max;

                // Encontra os múltiplos do passo dentro do range visível
                const firstBoundary = Math.ceil(yMin / step) * step;

                ctx.save();
                ctx.strokeStyle = currentModMode === 180 ? 'rgba(255, 150, 50, 0.55)' : 'rgba(180, 120, 255, 0.55)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);

                for (let boundary = firstBoundary; boundary <= yMax; boundary += step) {
                    if (boundary === 0) continue;
                    const yPixel = yScale.getPixelForValue(boundary);
                    ctx.beginPath();
                    ctx.moveTo(xScale.left, yPixel);
                    ctx.lineTo(xScale.right, yPixel);
                    ctx.stroke();

                    // Label indicando a fronteira do ciclo (ex: "180°" ou "360°")
                    ctx.save();
                    ctx.setLineDash([]);
                    ctx.fillStyle = currentModMode === 180 ? 'rgba(200, 100, 0, 0.85)' : 'rgba(150, 80, 220, 0.85)';
                    ctx.font = '10px sans-serif';
                    ctx.textAlign = 'right';
                    ctx.fillText(`${boundary}°`, xScale.left - 4, yPixel - 3);
                    ctx.restore();
                }
                ctx.restore();
            }
        }]
    });
}

/**
 * Prepara os pontos para exibição no gráfico de acordo com o modo ativo
 * (Mod 180° ou Mod 360°) e a configuração de continuidade (offset interno).
 * @returns {Array<{x: number, y: number}>} Pontos para plotagem.
 */
function getDisplayPoints() {
    if (!allDataPoints.length) return [];
    const mod = currentModMode; // 180 ou 360

    // Se a continuidade (offset interno) estiver desativada, plota em módulo puro (dente de serra natural)
    if (!continuityEnabled) {
        return allDataPoints.map(p => ({
            x: p.timestamp,
            y: mod === 180 ? p.angle180 : p.angle360
        }));
    }

    // Quando continuidade (offset interno) está ativa:
    const xMin = precessionChart?.scales?.x?.min;
    const xMax = precessionChart?.scales?.x?.max;

    // Se for visualização de longo prazo (> 72h) ou sem limites definidos (ex: zoom total),
    // exibe em módulo puro para que a visão global fique no intervalo [0, 180] ou [0, 360]
    if (!xMin || !xMax || (xMax - xMin > 72 * 3600 * 1000)) {
        return allDataPoints.map(p => ({
            x: p.timestamp,
            y: mod === 180 ? p.angle180 : p.angle360
        }));
    }

    // Para janelas de análise (<= 72h, como a inicial de 3h):
    // Aplica offset interno de visualização para continuidade perfeita
    let startIndex = 0;
    let endIndex = allDataPoints.length - 1;

    for (let i = 0; i < allDataPoints.length; i++) {
        if (allDataPoints[i].timestamp >= xMin) {
            startIndex = Math.max(0, i - 20);
            break;
        }
    }
    for (let i = allDataPoints.length - 1; i >= 0; i--) {
        if (allDataPoints[i].timestamp <= xMax) {
            endIndex = Math.min(allDataPoints.length - 1, i + 20);
            break;
        }
    }

    const result = [];
    const baseAngle = mod === 180 ? allDataPoints[startIndex].angle180 : allDataPoints[startIndex].angle360;
    let currentY = baseAngle;
    result.push({ x: allDataPoints[startIndex].timestamp, y: currentY });

    let lastRaw = allDataPoints[startIndex].angle180;
    for (let i = startIndex + 1; i <= endIndex; i++) {
        const p = allDataPoints[i];
        const diff = p.angle180 - lastRaw;
        const delta = diff - 180 * Math.round(diff / 180);
        currentY += delta;
        lastRaw = p.angle180;
        result.push({ x: p.timestamp, y: currentY });
    }
    return result;
}

/**
 * Atualiza os dados exibidos no gráfico e o título do eixo Y.
 */
function updateChartDisplayData() {
    if (!precessionChart) return;
    precessionChart.data.datasets[0].data = getDisplayPoints();
    precessionChart.options.scales.y.title.text = currentModMode === 180 
        ? 'Ângulo de Precessão (Mod 180°)' 
        : 'Ângulo de Precessão (Mod 360°)';
}

/**
 * Obtém os dados de `allDataPoints` que estão atualmente visíveis no gráfico.
 * @returns {Array<{timestamp: number, angle180: number, angle360: number}>} Array de pontos visíveis.
 */
function getVisibleChartData() {
    if (!precessionChart || !allDataPoints.length) return [];
    const minVisibleTime = precessionChart.scales.x.min;
    const maxVisibleTime = precessionChart.scales.x.max;
    if (minVisibleTime === undefined || maxVisibleTime === undefined) return allDataPoints;
    return allDataPoints.filter(p => p.timestamp >= minVisibleTime && p.timestamp <= maxVisibleTime);
}

/**
 * Atualiza as linhas de ajuste linear e teórica se estiverem ativas.
 * É chamada após zoom/pan ou quando novos dados chegam e o ajuste está ativo.
 */
function updateFitLinesIfActive() {
    if (!precessionChart || !fitLinesActive) {
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

    // Para o ajuste linear, desdobra localmente os pontos se a continuidade estiver ativa
    let pointsForFit;
    if (continuityEnabled) {
        const baseAngle = currentModMode === 180 ? visibleData[0].angle180 : visibleData[0].angle360;
        let currentY = baseAngle;
        pointsForFit = [{ x: timestampToHours(visibleData[0].timestamp), y: currentY }];
        let lastRaw = visibleData[0].angle180;
        for (let i = 1; i < visibleData.length; i++) {
            const diff = visibleData[i].angle180 - lastRaw;
            const delta = diff - 180 * Math.round(diff / 180);
            currentY += delta;
            lastRaw = visibleData[i].angle180;
            pointsForFit.push({ x: timestampToHours(visibleData[i].timestamp), y: currentY });
        }
    } else {
        pointsForFit = visibleData.map(p => ({
            x: timestampToHours(p.timestamp),
            y: currentModMode === 180 ? p.angle180 : p.angle360
        }));
    }

    const fit = calculateLinearRegressionWithLib(pointsForFit);

    if (fit) {
        const firstVisibleTimeHours = timestampToHours(visibleData[0].timestamp);
        const lastVisibleTimeHours = timestampToHours(visibleData[visibleData.length - 1].timestamp);

        precessionChart.data.datasets[1].data = [
            { x: visibleData[0].timestamp, y: fit.slope * firstVisibleTimeHours + fit.intercept },
            { x: visibleData[visibleData.length - 1].timestamp, y: fit.slope * lastVisibleTimeHours + fit.intercept }
        ];
        precessionChart.data.datasets[1].hidden = false;

        // Linha Teórica
        let sumVisibleTimeHours = 0;
        let sumVisibleY = 0;
        pointsForFit.forEach(p => {
            sumVisibleTimeHours += p.x;
            sumVisibleY += p.y;
        });
        const meanVisibleTimeHours = sumVisibleTimeHours / pointsForFit.length;
        const meanVisibleY = sumVisibleY / pointsForFit.length;

        const interceptTheoretical = meanVisibleY - THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR * meanVisibleTimeHours;

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
    if (!precessionChart || !allDataPoints.length) return;
    updateChartDisplayData();
    precessionChart.update('none');
    updateFitLinesIfActive();
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

    let pointsForFit;
    if (continuityEnabled) {
        const baseAngle = currentModMode === 180 ? visibleData[0].angle180 : visibleData[0].angle360;
        let currentY = baseAngle;
        pointsForFit = [{ x: timestampToHours(visibleData[0].timestamp), y: currentY }];
        let lastRaw = visibleData[0].angle180;
        for (let i = 1; i < visibleData.length; i++) {
            const diff = visibleData[i].angle180 - lastRaw;
            const delta = diff - 180 * Math.round(diff / 180);
            currentY += delta;
            lastRaw = visibleData[i].angle180;
            pointsForFit.push({ x: timestampToHours(visibleData[i].timestamp), y: currentY });
        }
    } else {
        pointsForFit = visibleData.map(p => ({
            x: timestampToHours(p.timestamp),
            y: currentModMode === 180 ? p.angle180 : p.angle360
        }));
    }

    const fit = calculateLinearRegressionWithLib(pointsForFit);

    if (fit) {
        meanPrecessionSpeedEl.textContent = `${fit.slope.toFixed(3)} ± ${fit.slopeError.toFixed(3)} °/hora (R²=${fit.rSquared.toFixed(3)})`;
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
    precessionChart.update();
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
    // Exporta o ângulo mod 180 e mod 360 (valores reais, sem acúmulo infinito)
    let csvContent = "data:text/csv;charset=utf-8,Timestamp (ms),Data Hora,Angulo Mod180 (°),Angulo Mod360 (°)\n";
    visibleData.forEach(p => {
        const dateTimeString = moment(p.timestamp).format('YYYY-MM-DD HH:mm:ss');
        csvContent += `${p.timestamp},${dateTimeString},${p.angle180.toFixed(ANGLE_DECIMAL_PLACES)},${p.angle360.toFixed(ANGLE_DECIMAL_PLACES)}\n`;
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

    // Calcula velocidade atual com os dois últimos pontos de allDataPoints
    if (allDataPoints.length >= 2) {
        const lastPoint = allDataPoints[allDataPoints.length - 1];
        const secondLastPoint = allDataPoints[allDataPoints.length - 2];
        const deltaTimeHours = (lastPoint.timestamp - secondLastPoint.timestamp) / (1000 * 60 * 60);
        if (deltaTimeHours > 0) {
            const diff = lastPoint.angle180 - secondLastPoint.angle180;
            const deltaAngle = diff - 180 * Math.round(diff / 180);
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
            initialMinTimestamp = allDataPoints[0].timestamp - (1 * 1000 * 60 * 60); // 1 hora antes
            initialMaxTimestamp = allDataPoints[0].timestamp + (1 * 1000 * 60 * 60); // 1 hora depois
        } else {
            const threeHoursAgo = initialMaxTimestamp - (INITIAL_VIEW_HOURS * 1000 * 60 * 60);
            const firstPointOverallTimestamp = allDataPoints[0].timestamp;

            if (threeHoursAgo < firstPointOverallTimestamp || allDataPoints.length < MIN_POINTS_INITIAL_VIEW) {
                const startIndex = Math.max(0, allDataPoints.length - MAX_INITIAL_VIEW_POINTS);
                initialMinTimestamp = allDataPoints[startIndex].timestamp;
            } else {
                initialMinTimestamp = threeHoursAgo;
            }
        }

        // Aplica ao gráfico diretamente
        precessionChart.options.scales.x.min = initialMinTimestamp;
        precessionChart.options.scales.x.max = initialMaxTimestamp;

        // Prepara os pontos com offset de visualização
        const displayData = getDisplayPoints();
        precessionChart.data.datasets[0].data = displayData;

        // Ajusta limites do eixo Y com margem em torno dos pontos visíveis
        if (displayData.length > 0) {
            let minY = Infinity, maxY = -Infinity;
            displayData.forEach(p => {
                if (p.x >= initialMinTimestamp && p.x <= initialMaxTimestamp) {
                    if (p.y < minY) minY = p.y;
                    if (p.y > maxY) maxY = p.y;
                }
            });
            if (minY !== Infinity && maxY !== -Infinity) {
                const margin = Math.max(3, (maxY - minY) * 0.15);
                precessionChart.options.scales.y.min = minY - margin;
                precessionChart.options.scales.y.max = maxY + margin;
            }
        }

        isFirstLoad = false;
    } else if (isFirstLoad && allDataPoints.length === 0) {
        delete precessionChart.options.scales.x.min;
        delete precessionChart.options.scales.x.max;
        isFirstLoad = false;
    } else {
        updateChartDisplayData();
    }

    precessionChart.update();
}

// -----------------------------------------------------------------------------
// Listeners de Eventos e Busca de Dados
// -----------------------------------------------------------------------------

btnLinearFit.addEventListener('click', performAndDisplayLinearFit);
btnExportData.addEventListener('click', exportVisibleDataToCSV);

btnMod180.addEventListener('click', () => {
    if (currentModMode === 180) return;
    currentModMode = 180;
    btnMod180.classList.add('active');
    btnMod180.classList.remove('inactive-mode');
    btnMod360.classList.remove('active');
    btnMod360.classList.add('inactive-mode');

    // Se estiver em visualização global (sem limites ou janela > 72h), atualiza a escala Y
    const xMin = precessionChart?.scales?.x?.min;
    const xMax = precessionChart?.scales?.x?.max;
    if (!xMin || !xMax || (xMax - xMin > 72 * 3600 * 1000)) {
        precessionChart.options.scales.y.min = -180 * 0.05;
        precessionChart.options.scales.y.max = 180 * 1.05;
    }

    updateChartDisplayData();
    precessionChart.update();
    updateFitLinesIfActive();
});

btnMod360.addEventListener('click', () => {
    if (currentModMode === 360) return;
    currentModMode = 360;
    btnMod360.classList.add('active');
    btnMod360.classList.remove('inactive-mode');
    btnMod180.classList.remove('active');
    btnMod180.classList.add('inactive-mode');

    // Se estiver em visualização global (sem limites ou janela > 72h), atualiza a escala Y
    const xMin = precessionChart?.scales?.x?.min;
    const xMax = precessionChart?.scales?.x?.max;
    if (!xMin || !xMax || (xMax - xMin > 72 * 3600 * 1000)) {
        precessionChart.options.scales.y.min = -360 * 0.05;
        precessionChart.options.scales.y.max = 360 * 1.05;
    }

    updateChartDisplayData();
    precessionChart.update();
    updateFitLinesIfActive();
});

btnToggleContinuity.addEventListener('click', () => {
    continuityEnabled = !continuityEnabled;
    btnToggleContinuity.classList.toggle('active', continuityEnabled);
    btnToggleContinuity.classList.toggle('inactive-mode', !continuityEnabled);
    btnToggleContinuity.textContent = continuityEnabled
        ? 'Continuidade: Ativa'
        : 'Continuidade: Desativada';

    updateChartDisplayData();
    precessionChart.update();
    updateFitLinesIfActive();
});

btnResetZoom.addEventListener('click', () => {
    if (precessionChart && allDataPoints.length > 0) {
        // Encontra o range total dos dados de tempo (X)
        const minTime = allDataPoints[0].timestamp;
        const maxTime = allDataPoints[allDataPoints.length - 1].timestamp;
        const xMargin = (maxTime - minTime) * 0.02;

        // Limites Y estritamente de acordo com o modo ativo:
        // Mod 180: 0° a 180°
        // Mod 360: 0° a 360°
        precessionChart.options.scales.x.min = minTime - xMargin;
        precessionChart.options.scales.x.max = maxTime + xMargin;
        precessionChart.options.scales.y.min = -currentModMode * 0.05;
        precessionChart.options.scales.y.max = currentModMode * 1.05;

        precessionChart.resetZoom('none');
        updateChartDisplayData();
        precessionChart.update();
        updateFitLinesIfActive();
    }
});

const dataRef = database.ref('pendulum_sensor_data').orderByChild('timestamp');

dataRef.on('value', (snapshot) => {
    console.log("Novos dados recebidos do Firebase!");
    const rawData = [];

    const MAX_ERROR_DEV = 0.5; // Filtra falhas graves da visão computacional (leituras normais são ~0.001 a 0.04)
    const MAX_PHYSICAL_SPEED_DEG_PER_HOUR = 25.0; // Limite de velocidade física plausível (~5.67°/h teórica em Araras-SP)

    snapshot.forEach((childSnapshot) => {
        const data = childSnapshot.val();
        if (data && typeof data.timestamp === 'number' && typeof data.angle_degrees === 'number') {
            // Filtro 1: Descarta leituras com falha de rastreio de visão computacional
            if (typeof data.error_deviation === 'number' && data.error_deviation > MAX_ERROR_DEV) {
                return;
            }

            const currentTimestamp = data.timestamp > 1e11 ? data.timestamp : data.timestamp * 1000;
            // Normaliza o ângulo bruto recebido para o intervalo [0, 180)
            const rawAngle180 = ((data.angle_degrees % 180) + 180) % 180;
            rawData.push({
                timestamp: currentTimestamp,
                rawAngle: rawAngle180,
                errorDev: data.error_deviation
            });
        }
    });

    // Ordena cronologicamente os dados brutos válidos
    rawData.sort((a, b) => a.timestamp - b.timestamp);

    const tempData = [];
    let lastValidRaw = null;
    let lastValidTs = null;
    let cumulativeAngle = null;

    // Rastreia passos incrementais para ciclo 360 e filtragem física
    for (let i = 0; i < rawData.length; i++) {
        const item = rawData[i];

        if (lastValidRaw === null) {
            cumulativeAngle = item.rawAngle;
        } else {
            const dtHours = (item.timestamp - lastValidTs) / (1000 * 3600);
            const diff = item.rawAngle - lastValidRaw;
            const delta = diff - 180 * Math.round(diff / 180);

            // Filtro 2: Gating de velocidade física
            if (dtHours > 0 && dtHours < 1.0) {
                const speed = Math.abs(delta) / dtHours;
                if (speed > MAX_PHYSICAL_SPEED_DEG_PER_HOUR) {
                    continue; // Ignora ponto discrepante
                }
            }

            cumulativeAngle += delta;
        }

        lastValidRaw = item.rawAngle;
        lastValidTs = item.timestamp;

        // Mod 180: estritamente no intervalo [0, 180)
        const a180 = ((item.rawAngle % 180) + 180) % 180;
        // Mod 360: estritamente no intervalo [0, 360)
        const a360 = ((cumulativeAngle % 360) + 360) % 360;

        tempData.push({
            timestamp: item.timestamp,
            angle180: a180,
            angle360: a360
        });
    }

    allDataPoints = tempData;
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