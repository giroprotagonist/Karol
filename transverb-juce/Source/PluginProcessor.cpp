#include "PluginProcessor.h"
#include "PluginEditor.h"
#include <cmath>
#include <random>

// ==============================================================================
//  Interpolation helpers
// ==============================================================================
inline float TransverbAudioProcessor::interpolateHermite(
    const float* buf, int bufSize, double readAddr, int writeAddr) noexcept
{
    auto const pos = static_cast<int>(readAddr);
    auto const fract = static_cast<float>(readAddr - static_cast<double>(pos));

    auto wrap = [bufSize](int idx) -> int {
        while (idx < 0) idx += bufSize;
        return idx % bufSize;
    };

    int p0 = wrap(pos - 1);
    int p1 = wrap(pos);
    int p2 = wrap(pos + 1);
    int p3 = wrap(pos + 2);

    auto addrDist = [bufSize](int w, int r) -> int {
        int diff = w - r;
        if (diff < 0) diff += bufSize;
        return diff;
    };

    int wDist = addrDist(writeAddr, pos);
    switch (wDist) {
        case 0:  p0 = p1;                              break;
        case 1:  p1 = wrap(pos - 1); p2 = p1; p3 = p1; break;
        case 2:  p2 = p1; p3 = p2;                     break;
        default:                                         break;
    }

    float y0 = buf[p0], y1 = buf[p1], y2 = buf[p2], y3 = buf[p3];
    float c0 = y1;
    float c1 = 0.5f * (y2 - y0);
    float c2 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * fract + c2) * fract + c1) * fract + c0;
}

inline float TransverbAudioProcessor::interpolateLinear(
    const float* buf, int bufSize, double readAddr) noexcept
{
    auto pos = static_cast<int>(readAddr);
    auto fract = static_cast<float>(readAddr - static_cast<double>(pos));
    int nextPos = (pos + 1) % bufSize;
    return buf[pos] + (buf[nextPos] - buf[pos]) * fract;
}

// ==============================================================================
//  IIR filter
// ==============================================================================
void TransverbAudioProcessor::computeIIRLowpass(
    float cutoffNorm, float& b0, float& b1, float& b2,
    float& a1, float& a2) noexcept
{
    const float pi = juce::MathConstants<float>::pi;
    float w0 = 2.0f * pi * cutoffNorm;
    float c  = std::cos(w0);
    float alpha = std::sin(w0) / (2.0f * 0.7071f);  // Butterworth Q

    float a0Inv = 1.0f / (1.0f + alpha);
    b0 = (1.0f - c) * 0.5f * a0Inv;
    b1 = (1.0f - c) * a0Inv;
    b2 = (1.0f - c) * 0.5f * a0Inv;
    a1 = 2.0f * c * a0Inv;
    a2 = -(1.0f - alpha) * a0Inv;
}

inline float TransverbAudioProcessor::runIIR(
    float input, float b0, float b1, float b2,
    float a1, float a2, float& z1, float& z2,
    float& y1, float& y2) noexcept
{
    float output = b0 * input + b1 * z1 + b2 * z2 + a1 * y1 + a2 * y2;
    z2 = z1; z1 = input;
    y2 = y1; y1 = output;
    return output;
}

inline float TransverbAudioProcessor::interpolateHermitePostFilter(
    const float* history, double readAddr, int historyWritePos) noexcept
{
    // history is a 4-entry ring buffer, historyWritePos is where the newest sample was written.
    // The readAddr fractional part gives the interpolation position.
    auto const pos = static_cast<size_t>(readAddr);
    auto const fract = static_cast<float>(readAddr - static_cast<double>(pos));

    int w  = historyWritePos & 3;
    int y0 = history[(w - 3) & 3];
    int y1 = history[(w - 2) & 3];
    int y2 = history[(w - 1) & 3];
    int y3 = history[w];

    float h0 = static_cast<float>(y0);
    float h1 = static_cast<float>(y1);
    float h2 = static_cast<float>(y2);
    float h3 = static_cast<float>(y3);

    float c0 = h1;
    float c1 = 0.5f * (h2 - h0);
    float c2 = h0 - 2.5f * h1 + 2.0f * h2 - 0.5f * h3;
    float c3 = 0.5f * (h3 - h0) + 1.5f * (h1 - h2);
    return ((c3 * fract + c2) * fract + c1) * fract + c0;
}

// ==============================================================================
//  Kaiser window
// ==============================================================================
float TransverbAudioProcessor::besselI0(float x)
{
    float sum = 1.0f, term = 1.0f;
    for (int i = 1; i < 25; ++i) {
        term *= (x * x) / (4.0f * static_cast<float>(i * i));
        sum += term;
    }
    return sum;
}

std::vector<float> TransverbAudioProcessor::generateKaiserWindow(int numTaps, float attenuationDB)
{
    std::vector<float> window(static_cast<size_t>(numTaps));
    float beta;
    if (attenuationDB > 50.0f)
        beta = 0.1102f * (attenuationDB - 8.7f);
    else if (attenuationDB >= 21.0f)
        beta = 0.5842f * std::pow(attenuationDB - 21.0f, 0.4f) + 0.07886f * (attenuationDB - 21.0f);
    else
        beta = 0.0f;

    float denom = besselI0(beta);
    int M = (numTaps - 1) / 2;
    for (int i = 0; i < numTaps; ++i) {
        float n = static_cast<float>(i - M) / static_cast<float>(M);
        window[static_cast<size_t>(i)] = besselI0(beta * std::sqrt(1.0f - n * n)) / denom;
    }
    return window;
}

// ==============================================================================
//  Parameter layout
// ==============================================================================
juce::AudioProcessorValueTreeState::ParameterLayout
TransverbAudioProcessor::createParameterLayout()
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;

    // Buffer size: 1–3000 ms, default 2700
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramBufferSize, 1), "Buffer Size",
        juce::NormalisableRange<float>(1.0f, 3000.0f, 0.1f), 2700.0f,
        "ms", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(static_cast<int>(v)) + " ms"; },
        [](const juce::String& s) { return s.getFloatValue(); }));

    // Speed: octaves, -3 to +6, Speed1=0.0, Speed2=1.0
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramSpeed1, 1), "Speed 1",
        juce::NormalisableRange<float>(-3.0f, 6.0f, 0.001f), 0.0f,
        "oct", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(v, 2) + " oct"; },
        [](const juce::String& s) { return s.getFloatValue(); }));
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramSpeed2, 1), "Speed 2",
        juce::NormalisableRange<float>(-3.0f, 6.0f, 0.001f), 1.0f,
        "oct", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(v, 2) + " oct"; },
        [](const juce::String& s) { return s.getFloatValue(); }));

    // Feedback: 0–100%, default 0.0
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramFeedback1, 1), "Feedback 1",
        juce::NormalisableRange<float>(0.0f, 100.0f, 0.1f), 0.0f,
        "%", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(static_cast<int>(v)) + "%"; },
        [](const juce::String& s) { return s.getFloatValue(); }));
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramFeedback2, 1), "Feedback 2",
        juce::NormalisableRange<float>(0.0f, 100.0f, 0.1f), 0.0f,
        "%", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(static_cast<int>(v)) + "%"; },
        [](const juce::String& s) { return s.getFloatValue(); }));

    // Distance: 0–1, defaults 0.9 and 0.1
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramDistance1, 1), "Distance 1",
        juce::NormalisableRange<float>(0.0f, 1.0f, 0.001f), 0.90009f,
        "", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(v, 3); },
        [](const juce::String& s) { return s.getFloatValue(); }));
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramDistance2, 1), "Distance 2",
        juce::NormalisableRange<float>(0.0f, 1.0f, 0.001f), 0.1f,
        "", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(v, 3); },
        [](const juce::String& s) { return s.getFloatValue(); }));

    // Mix (0–1, default dry=1.0, wet1=1.0, wet2=0.0 – squared curve applied in processBlock)
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramDryMix, 1), "Dry Mix",
        juce::NormalisableRange<float>(0.0f, 1.0f, 0.001f), 1.0f,
        "", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(static_cast<int>(v * 100.0f)) + "%"; },
        [](const juce::String& s) { return s.getFloatValue() / 100.0f; }));
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramWetMix1, 1), "Wet Mix 1",
        juce::NormalisableRange<float>(0.0f, 1.0f, 0.001f), 1.0f,
        "", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(static_cast<int>(v * 100.0f)) + "%"; },
        [](const juce::String& s) { return s.getFloatValue() / 100.0f; }));
    layout.add(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID(paramWetMix2, 1), "Wet Mix 2",
        juce::NormalisableRange<float>(0.0f, 1.0f, 0.001f), 0.0f,
        "", juce::AudioProcessorParameter::genericParameter,
        [](float v, int) { return juce::String(static_cast<int>(v * 100.0f)) + "%"; },
        [](const juce::String& s) { return s.getFloatValue() / 100.0f; }));

    // Quality: Dirt-Fi(0), Hi-Fi(1), Ultra Hi-Fi(2) — default Ultra Hi-Fi
    layout.add(std::make_unique<juce::AudioParameterChoice>(
        juce::ParameterID(paramQuality, 1), "Quality",
        juce::StringArray{"Dirt-Fi", "Hi-Fi", "Ultra Hi-Fi"}, 2));

    // Toggles
    layout.add(std::make_unique<juce::AudioParameterBool>(
        juce::ParameterID(paramTomsound, 1), "TOMSOUND", false));
    layout.add(std::make_unique<juce::AudioParameterBool>(
        juce::ParameterID(paramFreeze, 1), "Freeze", false));
    layout.add(std::make_unique<juce::AudioParameterBool>(
        juce::ParameterID(paramAttenFb, 1), "-fdb", false));

    return layout;
}

// ==============================================================================
//  Presets init
// ==============================================================================
void TransverbAudioProcessor::initPresets()
{
    // Default (index 0) uses the parameter defaults
    presets[0] = PresetData{};

    // Preset 1: "phaser up"
    presets[1] = PresetData{ 48.687f, 0.0484066f/12.0f, 0.0f, 33.5f, 0.0f, 0.1f, 0.0f, 0.45f, 0.5f, 0.0f, 2, false, false, false };
    // Preset 2: "phaser down"
    presets[2] = PresetData{ 27.0f, -0.1204f/12.0f, 0.0f, 38.0f, 0.0f, 0.0f, 0.0f, 0.45f, 0.5f, 0.0f, 2, false, false, false };
    // Preset 3: "aquinas"
    presets[3] = PresetData{ 2605.0f, -4.66f, 2.44f, 93.336f, 77.78f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 2, false, false, false };
    // Preset 4: "glup drums"
    presets[4] = PresetData{ 184.0f, -0.6667f, -3.0f, 97.613f, 0.0f, 0.0f, 0.0f, 0.45f, 1.0f, 0.0f, 2, false, false, false };
    // Preset 5: "space invaders"
    presets[5] = PresetData{ 16.837f, 0.078f, 0.0933f, 46.0f, 38.0f, 0.0f, 0.0f, 0.0036f, 0.5f, 0.5f, 1, false, false, false };
    // Preset 6: "mudslap"
    presets[6] = PresetData{ 122.0f, -1.0f, 1.0f, 76.666f, 38.333f, 0.0f, 0.0f, 0.5f, 0.5f, 0.5f, 0, false, false, false };
    // Preset 7: "subverb"
    presets[7] = PresetData{ 2341.0f, -0.79f, 0.34f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 2, true, false, false };
    // Preset 8: "vocoder beat"
    presets[8] = PresetData{ 65.0f, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.5f, 0.5f, 0.5f, 0, false, false, false };
    // Preset 9: "yo pitch!"
    presets[9] = PresetData{ 1938.0f, -2.0f, 2.0f, 80.0f, 19.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.5f, 2, false, false, false };
    // Presets 10-14: filler
    for (int i = 10; i < 15; ++i) presets[i] = PresetData{};
    // Preset 15: "random" (handled specially)
    presets[15] = PresetData{};

    programNames[0]  = "Transverb";
    programNames[1]  = "phaser up";
    programNames[2]  = "phaser down";
    programNames[3]  = "aquinas";
    programNames[4]  = "glup drums";
    programNames[5]  = "space invaders";
    programNames[6]  = "mudslap";
    programNames[7]  = "subverb";
    programNames[8]  = "vocoder beat";
    programNames[9]  = "yo pitch!";
    programNames[10] = "preset 11";
    programNames[11] = "preset 12";
    programNames[12] = "preset 13";
    programNames[13] = "preset 14";
    programNames[14] = "preset 15";
    programNames[15] = "random";
}

// ==============================================================================
//  Constructor
// ==============================================================================
TransverbAudioProcessor::TransverbAudioProcessor()
    : AudioProcessor(BusesProperties()
                         .withInput("Input",  juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true))
    , apvts(*this, nullptr, "TransverbState", createParameterLayout())
{
    pBufferSize = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramBufferSize));
    pSpeed1     = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramSpeed1));
    pSpeed2     = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramSpeed2));
    pFeedback1  = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramFeedback1));
    pFeedback2  = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramFeedback2));
    pDistance1  = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramDistance1));
    pDistance2  = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramDistance2));
    pDryMix     = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramDryMix));
    pWetMix1    = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramWetMix1));
    pWetMix2    = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(paramWetMix2));
    pQuality    = dynamic_cast<juce::AudioParameterChoice*>(apvts.getParameter(paramQuality));
    pTomsound   = dynamic_cast<juce::AudioParameterBool*>(apvts.getParameter(paramTomsound));
    pFreeze     = dynamic_cast<juce::AudioParameterBool*>(apvts.getParameter(paramFreeze));
    pAttenFb    = dynamic_cast<juce::AudioParameterBool*>(apvts.getParameter(paramAttenFb));

    initPresets();
}

// ==============================================================================
//  AudioProcessor overrides
// ==============================================================================
const juce::String TransverbAudioProcessor::getName() const { return "Transverb"; }
bool TransverbAudioProcessor::acceptsMidi() const   { return false; }
bool TransverbAudioProcessor::producesMidi() const  { return false; }
bool TransverbAudioProcessor::isMidiEffect() const  { return false; }
double TransverbAudioProcessor::getTailLengthSeconds() const { return 3.0; }

int TransverbAudioProcessor::getNumPrograms() { return kNumPresets; }
int TransverbAudioProcessor::getCurrentProgram() { return currentProgram; }

void TransverbAudioProcessor::setCurrentProgram(int index)
{
    if (index < 0 || index >= kNumPresets) return;
    currentProgram = index;

    // "random" preset triggers randomization
    if (index == kNumPresets - 1) {
        randomizeAllParameters();
        return;
    }

    const auto& p = presets[static_cast<size_t>(index)];
    *pBufferSize = p.bufferSize;
    *pSpeed1 = p.speed1;
    *pSpeed2 = p.speed2;
    *pFeedback1 = p.feedback1;
    *pFeedback2 = p.feedback2;
    *pDistance1 = p.distance1;
    *pDistance2 = p.distance2;
    *pDryMix = p.dryMix;
    *pWetMix1 = p.wetMix1;
    *pWetMix2 = p.wetMix2;
    *pQuality = p.quality;
    *pTomsound = p.tomsound;
    *pFreeze = p.freeze;
    *pAttenFb = p.attenFb;
}

const juce::String TransverbAudioProcessor::getProgramName(int index)
{
    if (index >= 0 && index < kNumPresets)
        return programNames[static_cast<size_t>(index)];
    return {};
}
void TransverbAudioProcessor::changeProgramName(int, const juce::String&) {}

// ==============================================================================
//  State save/restore
// ==============================================================================
void TransverbAudioProcessor::getStateInformation(juce::MemoryBlock& destData)
{
    auto state = apvts.copyState();
    state.setProperty("speedMode0", speedModes[0], nullptr);
    state.setProperty("speedMode1", speedModes[1], nullptr);
    std::unique_ptr<juce::XmlElement> xml(state.createXml());
    copyXmlToBinary(*xml, destData);
}

void TransverbAudioProcessor::setStateInformation(const void* data, int sizeInBytes)
{
    std::unique_ptr<juce::XmlElement> xmlState(getXmlFromBinary(data, sizeInBytes));
    if (xmlState && xmlState->hasTagName(apvts.state.getType())) {
        auto tree = juce::ValueTree::fromXml(*xmlState);
        apvts.replaceState(tree);
        speedModes[0] = tree.getProperty("speedMode0", 0);
        speedModes[1] = tree.getProperty("speedMode1", 0);
    }
}

// ==============================================================================
//  Bus layout
// ==============================================================================
bool TransverbAudioProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()
     && layouts.getMainOutputChannelSet() != juce::AudioChannelSet::mono())
        return false;
    if (layouts.getMainOutputChannelSet() != layouts.getMainInputChannelSet())
        return false;
    return true;
}

// ==============================================================================
//  prepareToPlay / releaseResources
// ==============================================================================
void TransverbAudioProcessor::prepareToPlay(double sr, int /*maxSamplesPerBlock*/)
{
    sampleRate = sr;
    MAXBUF = static_cast<int>(std::ceil(3000.0 * 0.001 * sr));  // max 3 seconds
    bsize   = std::clamp(static_cast<int>(pBufferSize->get() * sr * 0.001), 1, MAXBUF);
    writePos = 0;

    for (auto& h : heads) {
        h.buf.assign(static_cast<size_t>(MAXBUF), 0.0f);
        h.readPos = 0.0;
        h.smoothCount = 0;
        h.smoothStep = 0.0f;
        h.lastDelayVal = 0.0f;
        h.currentSpeed = 1.0f;
        h.speedChanged = false;
        h.iirZ1 = h.iirZ2 = h.iirY1 = h.iirY2 = 0.0f;
        for (auto& v : h.iirHistory) v = 0.0f;
        h.iirHistoryPos = 0;
        h.lowpassPos = 0;
        h.firValid = false;
        h.firCoefficients.assign(kNumFIRTaps, 0.0f);
    }
}

void TransverbAudioProcessor::releaseResources()
{
    for (auto& h : heads) h.buf.clear();
}

// ==============================================================================
//  randomizeAllParameters  –  matching the original destroyfx algorithm
// ==============================================================================
void TransverbAudioProcessor::randomizeAllParameters()
{
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_real_distribution<float> dist(0.0f, 1.0f);

    // Buffer size: pow(rand[0.07..1], 1.38) mapped to [1, 3000]
    {
        float r = 0.07f + dist(gen) * 0.93f;
        *pBufferSize = std::pow(r, 1.38f) * 3000.0f;
        if (*pBufferSize < 1.0f) *pBufferSize = 1.0f;
    }

    // Speed: rand in [-1, 1], negative maps to abs(rand) * minRange, positive to abs(rand) * maxRange
    auto randSpeed = [&]() {
        float r = dist(gen) * 2.0f - 1.0f;
        if (r < 0.0f) return -std::abs(r) * 3.0f;
        return std::abs(r) * 6.0f;
    };
    *pSpeed1 = randSpeed();
    *pSpeed2 = randSpeed();

    // Feedback: uniform 0-100
    *pFeedback1 = dist(gen) * 100.0f;
    *pFeedback2 = dist(gen) * 100.0f;

    // Distance and freeze not randomized (they're in kAttribute_OmitFromRandomizeAll)
    // AttenFb also omitted

    // Mix levels: randomize then normalize to preserve total
    float d = std::pow(dist(gen), 0.5f);  // squared curve: pow is applied in processBlock
    float m1 = std::pow(dist(gen), 0.5f);
    float m2 = std::pow(dist(gen), 0.5f);
    float mixSum = d + m1 + m2;
    if (mixSum > 0.0f) {
        float scalar = 1.0f / mixSum;
        d = std::min(d * scalar, 1.0f);
        m1 = std::min(m1 * scalar, 1.0f);
        m2 = std::min(m2 * scalar, 1.0f);
    }
    *pDryMix = d;
    *pWetMix1 = m1;
    *pWetMix2 = m2;

    // TOMSOUND: 1/3 probability
    *pTomsound = (static_cast<int>(dist(gen) * 3.0f) % 2) == 0;

    // Quality: favor Hi-Fi/UltraHiFi 4:1 unless TOMSOUND is on (then uniform)
    if (*pTomsound)
        *pQuality = static_cast<int>(dist(gen) * 3.0f);
    else
        *pQuality = (dist(gen) < 0.2f) ? 0 : (1 + static_cast<int>(dist(gen) * 2.0f));
}

// ==============================================================================
//  processBlock  –  the DSP core
// ==============================================================================
void TransverbAudioProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    // --- Read parameters ---
    float bufMs      = pBufferSize->get();
    float speed1Oct  = pSpeed1->get();
    float speed2Oct  = pSpeed2->get();
    float feedback1  = pFeedback1->get();
    float feedback2  = pFeedback2->get();
    float distance1  = pDistance1->get();
    float distance2  = pDistance2->get();
    float dryMixP    = pDryMix->get();
    float wetMix1P   = pWetMix1->get();
    float wetMix2P   = pWetMix2->get();
    int   qualityMode = pQuality->getIndex();
    bool  tomsound   = pTomsound->get();
    bool  freeze     = pFreeze->get();
    bool  attenFb    = pAttenFb->get();

    // Convert octaves to speed multiplier
    auto octavesToSpeed = [](float oct) -> float {
        return std::pow(2.0f, oct);
    };
    float targetSpeed1 = octavesToSpeed(speed1Oct);
    float targetSpeed2 = octavesToSpeed(speed2Oct);

    // Smooth parameter changes
    const float smoothCoeff = 0.995f;
    smoothDryMix = smoothDryMix * smoothCoeff + dryMixP * dryMixP * (1.0f - smoothCoeff);            // squared curve
    smoothFeed1  = smoothFeed1  * smoothCoeff + (feedback1 / 100.0f) * (1.0f - smoothCoeff);
    smoothFeed2  = smoothFeed2  * smoothCoeff + (feedback2 / 100.0f) * (1.0f - smoothCoeff);
    smoothWet1   = smoothWet1   * smoothCoeff + wetMix1P * wetMix1P * (1.0f - smoothCoeff);          // squared curve
    smoothWet2   = smoothWet2   * smoothCoeff + wetMix2P * wetMix2P * (1.0f - smoothCoeff);          // squared curve
    smoothSpeed1 = smoothSpeed1 * smoothCoeff + targetSpeed1 * (1.0f - smoothCoeff);
    smoothSpeed2 = smoothSpeed2 * smoothCoeff + targetSpeed2 * (1.0f - smoothCoeff);

    // Detect speed changes for filter re-init
    for (int h = 0; h < 2; ++h) {
        float spd = (h == 0) ? smoothSpeed1 : smoothSpeed2;
        if (std::abs(heads[static_cast<size_t>(h)].currentSpeed - spd) > 0.001f) {
            heads[static_cast<size_t>(h)].speedChanged = true;
            heads[static_cast<size_t>(h)].currentSpeed = spd;
        }
    }

    // Update bsize from parameter (soft limit, never exceeds MAXBUF)
    int newBsize = std::clamp(static_cast<int>(bufMs * sampleRate * 0.001), 1, MAXBUF);
    if (newBsize != bsize) {
        if (newBsize > bsize) {
            // expanding: new area is already zeroed from reset or not yet used
        } else if (writePos > newBsize) {
            writePos %= newBsize;
        }
        bsize = newBsize;
        for (auto& h : heads) {
            h.readPos = std::fmod(h.readPos, static_cast<double>(bsize));
            if (h.readPos < 0.0) h.readPos += static_cast<double>(bsize);
        }
    }

    if (bsize <= 0) return;

    // Initialize read head positions from distance on first block
    if (heads[0].readPos <= 0.0 && heads[1].readPos <= 0.0) {
        auto initRead = [this](float dist) -> double {
            double pos = static_cast<double>(writePos) - dist * static_cast<double>(bsize);
            while (pos < 0.0) pos += static_cast<double>(bsize);
            return std::fmod(pos, static_cast<double>(bsize));
        };
        heads[0].readPos = initRead(distance1);
        heads[1].readPos = initRead(distance2);
    }

    int numSamples  = buffer.getNumSamples();
    int numChannels = buffer.getNumChannels();
    bool isStereo   = (numChannels > 1);

    auto* chL = buffer.getWritePointer(0);
    auto* chR = isStereo ? buffer.getWritePointer(1) : chL;

    int writerIncrement = freeze ? 0 : 1;

    // ====================================================================
    //  S O P H I A S O U N D
    // ====================================================================
    if (!tomsound) {
        // Re-init per-head FIR if in Ultra Hi-Fi with speed >= 5 and speed changed
        if (qualityMode == 2) {
            for (int h = 0; h < 2; ++h) {
                auto& head = heads[static_cast<size_t>(h)];
                float spd = (h == 0) ? smoothSpeed1 : smoothSpeed2;
                if (spd >= static_cast<float>(kFIRSpeedThreshold) && head.speedChanged) {
                    double cutoff = (sampleRate / static_cast<double>(spd)) * 0.9;
                    double fcNorm = cutoff / sampleRate;
                    auto kaiserWin = generateKaiserWindow(kNumFIRTaps, 60.0f);
                    int M = (kNumFIRTaps - 1) / 2;
                    head.firCoefficients.resize(kNumFIRTaps);
                    for (int i = 0; i < kNumFIRTaps; ++i) {
                        int n = i - M;
                        double sinc;
                        if (n == 0) sinc = 2.0 * fcNorm;
                        else sinc = std::sin(2.0 * juce::MathConstants<double>::pi * fcNorm * static_cast<double>(n))
                                  / (juce::MathConstants<double>::pi * static_cast<double>(n));
                        head.firCoefficients[static_cast<size_t>(i)] = static_cast<float>(sinc * kaiserWin[static_cast<size_t>(i)]);
                    }
                    head.firValid = true;
                }
            }
        }

        for (int i = 0; i < numSamples; ++i) {
            float inputSample = chL[i];
            std::array<float, 2> delayvals = { 0.0f, 0.0f };

            for (int h = 0; h < 2; ++h) {
                auto& head = heads[static_cast<size_t>(h)];
                float spd  = (h == 0) ? smoothSpeed1 : smoothSpeed2;
                int readInt = static_cast<int>(head.readPos);

                // --- Read from per-head buffer ---
                switch (qualityMode) {
                    case 0: { // Dirt-Fi
                        int idx = readInt;
                        while (idx < 0) idx += bsize;
                        idx %= bsize;
                        delayvals[static_cast<size_t>(h)] = head.buf[static_cast<size_t>(idx)];
                        break;
                    }
                    case 1: { // Hi-Fi – Hermite
                        double rp = std::fmod(head.readPos, static_cast<double>(bsize));
                        if (rp < 0.0) rp += static_cast<double>(bsize);
                        delayvals[static_cast<size_t>(h)] = interpolateHermite(
                            head.buf.data(), bsize, rp, writePos);
                        break;
                    }
                    case 2: { // Ultra Hi-Fi
                        double rp = std::fmod(head.readPos, static_cast<double>(bsize));
                        if (rp < 0.0) rp += static_cast<double>(bsize);

                        float rawVal = interpolateHermite(head.buf.data(), bsize, rp, writePos);

                        if (spd > 1.0f) {
                            // Anti-alias lowpass
                            if (spd >= static_cast<float>(kFIRSpeedThreshold)) {
                                // FIR: two consecutive FIR outputs + linear interpolation
                                auto wrapIdx = [this](int base) -> int {
                                    while (base < 0) base += bsize;
                                    return base % bsize;
                                };
                                int mid = (kNumFIRTaps - 1) / 2;
                                auto firProc = [&](int startIdx) {
                                    float sum = 0.0f;
                                    for (int t = 0; t < kNumFIRTaps; ++t) {
                                        int idx = wrapIdx(startIdx + t);
                                        sum += head.buf[static_cast<size_t>(idx)] * head.firCoefficients[static_cast<size_t>(t)];
                                    }
                                    return sum;
                                };
                                float f1 = firProc(readInt - mid);
                                float f2 = firProc(readInt - mid + 1);
                                float fract = static_cast<float>(head.readPos - std::floor(head.readPos));
                                float mug = std::pow(spd / static_cast<float>(kFIRSpeedThreshold), 0.78f);
                                delayvals[static_cast<size_t>(h)] = (f1 + (f2 - f1) * fract) * mug;
                            } else {
                                // IIR: multi-iteration + output history cache
                                if (head.speedChanged) {
                                    double cutoff = (sampleRate / static_cast<double>(spd)) * 0.45;
                                    float cutoffNorm = static_cast<float>(cutoff / sampleRate);
                                    computeIIRLowpass(cutoffNorm, head.iirB0, head.iirB1, head.iirB2,
                                                      head.iirA1, head.iirA2);
                                    head.iirNumIterations = std::max(1, static_cast<int>(spd));
                                }
                                // Run IIR iterations over consecutive source samples
                                int pos = head.lowpassPos;
                                int remaining = head.iirNumIterations;
                                while (remaining > 0) {
                                    auto batch = std::min(remaining, 4);
                                    for (int k = 0; k < batch; ++k) {
                                        int idx = (pos + k) % bsize;
                                        if (idx < 0) idx += bsize;
                                        float out = runIIR(head.buf[static_cast<size_t>(idx)],
                                                          head.iirB0, head.iirB1, head.iirB2,
                                                          head.iirA1, head.iirA2,
                                                          head.iirZ1, head.iirZ2,
                                                          head.iirY1, head.iirY2);
                                        head.iirHistory[head.iirHistoryPos & 3] = out;
                                        head.iirHistoryPos++;
                                    }
                                    pos = (pos + batch) % bsize;
                                    if (pos < 0) pos += bsize;
                                    remaining -= batch;
                                }
                                head.lowpassPos = (pos + 1) % bsize;
                                if (head.lowpassPos < 0) head.lowpassPos += bsize;
                                // Read interpolated value from history
                                delayvals[static_cast<size_t>(h)] = interpolateHermitePostFilter(
                                    head.iirHistory,
                                    static_cast<double>(head.iirHistoryPos - head.iirNumIterations)
                                        + (head.readPos - std::floor(head.readPos)),
                                    head.iirHistoryPos);
                            }
                        } else if (spd < 1.0f) {
                            // Highpass
                            if (head.speedChanged) {
                                double cutoff = kHighpassCutoff / static_cast<double>(std::max(0.1f, spd));
                                float cutoffNorm = static_cast<float>(cutoff / sampleRate);
                                // Butterworth highpass via bilinear transform
                                const float pi = juce::MathConstants<float>::pi;
                                float w0 = 2.0f * pi * cutoffNorm;
                                float c  = std::cos(w0);
                                float alpha = std::sin(w0) / (2.0f * 0.7071f);
                                float a0Inv = 1.0f / (1.0f + alpha);
                                head.iirB0 = (1.0f + c) * 0.5f * a0Inv;
                                head.iirB1 = -(1.0f + c) * a0Inv;
                                head.iirB2 = (1.0f + c) * 0.5f * a0Inv;
                                head.iirA1 = 2.0f * c * a0Inv;
                                head.iirA2 = -(1.0f - alpha) * a0Inv;
                                head.iirNumIterations = 1;
                            }
                            // Single highpass iteration
                            int readIdx = readInt % bsize;
                            if (readIdx < 0) readIdx += bsize;
                            float filtered = runIIR(head.buf[static_cast<size_t>(readIdx)],
                                                    head.iirB0, head.iirB1, head.iirB2,
                                                    head.iirA1, head.iirA2,
                                                    head.iirZ1, head.iirZ2,
                                                    head.iirY1, head.iirY2);
                            head.iirHistory[head.iirHistoryPos & 3] = filtered;
                            head.iirHistoryPos++;
                            delayvals[static_cast<size_t>(h)] = interpolateHermitePostFilter(
                                head.iirHistory, head.readPos, head.iirHistoryPos);
                        } else {
                            delayvals[static_cast<size_t>(h)] = rawVal;
                        }
                        break;
                    }
                }

                // --- Crossfade smoothing ---
                if (head.smoothCount > 0) {
                    float smoothPos = head.smoothStep * static_cast<float>(head.smoothCount);
                    delayvals[static_cast<size_t>(h)] = head.lastDelayVal
                        + (delayvals[static_cast<size_t>(h)] - head.lastDelayVal) * smoothPos;
                    head.smoothCount--;
                }

                // --- Write to per-head buffer with feedback ---
                float feed = (h == 0) ? smoothFeed1 : smoothFeed2;
                if (!freeze) {
                    float mixlevel = attenFb ? ((h == 0) ? smoothWet1 : smoothWet2) : 1.0f;
                    head.buf[static_cast<size_t>(writePos)] =
                        inputSample + delayvals[static_cast<size_t>(h)] * feed * mixlevel;
                }

                // --- Detect crossing ---
                int nextReadInt = static_cast<int>(head.readPos + static_cast<double>(spd));
                int nextWrite   = writePos + 1;
                if (nextWrite >= bsize) nextWrite -= bsize;

                auto wrapDist = [this](int a, int b) -> int {
                    int d = b - a;
                    return (d < 0) ? (d + bsize) : d;
                };
                bool readCrossingAhead  = (wrapDist(writePos, readInt) > 0) && (wrapDist(nextWrite, nextReadInt) == 0);
                bool readCrossingBehind = (wrapDist(writePos, readInt) == 0) && (wrapDist(nextWrite, nextReadInt) > 0);
                bool speedIsUnity = (std::abs(spd - 1.0f) < 0.0001f);

                if ((readCrossingAhead || readCrossingBehind) && !speedIsUnity && head.smoothCount <= 0) {
                    head.lastDelayVal = delayvals[static_cast<size_t>(h)];
                    int smoothDur = std::min(
                        static_cast<int>(static_cast<double>(bsize) / static_cast<double>(std::max(0.01f, spd))),
                        kAudioSmoothingDur);
                    smoothDur = std::max(1, smoothDur);
                    head.smoothStep = 1.0f / static_cast<float>(smoothDur);
                    head.smoothCount = smoothDur;
                }

                // --- Advance read head ---
                head.readPos += static_cast<double>(spd);
                if (head.readPos >= static_cast<double>(bsize))
                    head.readPos = std::fmod(head.readPos, static_cast<double>(bsize));
            }

            // Advance write head
            writePos = (writePos + writerIncrement) % bsize;

            // Output mix
            float outL = inputSample * smoothDryMix
                + delayvals[0] * smoothWet1 + delayvals[1] * smoothWet2;
            chL[i] = outL;

            if (isStereo) {
                float outR = inputSample * smoothDryMix + delayvals[1] * smoothWet2;
                chR[i] = outR;
            }
        }
    }
    // ====================================================================
    //  T O M S O U N D
    // ====================================================================
    else {
        constexpr int tMult = 2;

        for (int i = 0; i < numSamples; ++i) {
            float inputSample = chL[i];
            std::array<float, 2> delayvals = { 0.0f, 0.0f };

            // Read from shared buffer (heads[0].buf) in TOMSOUND
            for (int h = 0; h < 2; ++h) {
                auto& head = heads[static_cast<size_t>(h)];
                int readInt = static_cast<int>(head.readPos);
                auto& buf = attenFb ? heads[0].buf : head.buf; // shared when attenFb

                switch (qualityMode) {
                    case 0: {
                        int idx = readInt;
                        while (idx < 0) idx += bsize;
                        idx %= bsize;
                        delayvals[static_cast<size_t>(h)] = buf[static_cast<size_t>(idx)];
                        break;
                    }
                    case 1: {
                        double rp = std::fmod(head.readPos, static_cast<double>(bsize));
                        if (rp < 0.0) rp += static_cast<double>(bsize);
                        delayvals[static_cast<size_t>(h)] = interpolateLinear(buf.data(), bsize, rp);
                        break;
                    }
                    case 2: {
                        double rp = std::fmod(head.readPos, static_cast<double>(bsize));
                        if (rp < 0.0) rp += static_cast<double>(bsize);
                        delayvals[static_cast<size_t>(h)] = interpolateHermite(buf.data(), bsize, rp, writePos);
                        break;
                    }
                }
            }

            // Write (shared buffer logic)
            if (!freeze) {
                if (attenFb) {
                    auto& buf = heads[0].buf;
                    buf[static_cast<size_t>(writePos)] = inputSample;
                    for (int h = 0; h < 2; ++h) {
                        float feed = (h == 0) ? smoothFeed1 : smoothFeed2;
                        float wet  = (h == 0) ? smoothWet1 : smoothWet2;
                        buf[static_cast<size_t>(writePos)] += feed * wet * delayvals[static_cast<size_t>(h)];
                    }
                } else {
                    for (int h = 0; h < 2; ++h) {
                        float feed = (h == 0) ? smoothFeed1 : smoothFeed2;
                        auto& buf = heads[static_cast<size_t>(h)].buf;
                        buf[static_cast<size_t>(writePos)] =
                            inputSample + delayvals[static_cast<size_t>(h)] * feed;
                    }
                }
            }

            // Advance read heads (double)
            for (int h = 0; h < 2; ++h) {
                float spd = (h == 0) ? smoothSpeed1 : smoothSpeed2;
                auto& head = heads[static_cast<size_t>(h)];
                head.readPos += static_cast<double>(spd * static_cast<float>(tMult));
                if (head.readPos >= static_cast<double>(bsize))
                    head.readPos = std::fmod(head.readPos, static_cast<double>(bsize));
            }

            // Advance write head (double, odd-wrapped)
            int bsizeWriteWrap = bsize - ((bsize % tMult) ? 0 : 1);
            writePos = (writePos + tMult);
            if (writePos >= bsize)
                writePos %= bsizeWriteWrap;

            // Output
            float outL = inputSample * smoothDryMix
                + delayvals[0] * smoothWet1 + delayvals[1] * smoothWet2;
            chL[i] = outL;

            if (isStereo) {
                float outR = inputSample * smoothDryMix + delayvals[1] * smoothWet2;
                chR[i] = outR;
            }
        }
    }
}

// ==============================================================================
//  Editor / Factory
// ==============================================================================
bool TransverbAudioProcessor::hasEditor() const { return true; }
juce::AudioProcessorEditor* TransverbAudioProcessor::createEditor()
{
    return new TransverbAudioProcessorEditor(*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new TransverbAudioProcessor();
}
