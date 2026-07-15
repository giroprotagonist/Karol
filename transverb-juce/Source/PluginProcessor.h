#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <array>
#include <vector>

// ==============================================================================
//  TransverbAudioProcessor
//
//  A JUCE-based reimplementation of Destroy FX Transverb.
//  Two independent read heads sweep through per-head delay buffers at variable
//  speeds, creating tape-loop-style pitch shifts, glitches, and reverb-like
//  textures.  Faithful to the original by Tom Murphy 7 and Sophia Poirier (GPL v2+).
// ==============================================================================
class TransverbAudioProcessor : public juce::AudioProcessor
{
public:
    // Parameter IDs (used by host automation)
    static constexpr auto paramBufferSize = "bufferSize";
    static constexpr auto paramSpeed1    = "speed1";
    static constexpr auto paramFeedback1 = "feedback1";
    static constexpr auto paramDistance1 = "distance1";
    static constexpr auto paramSpeed2    = "speed2";
    static constexpr auto paramFeedback2 = "feedback2";
    static constexpr auto paramDistance2 = "distance2";
    static constexpr auto paramDryMix    = "dryMix";
    static constexpr auto paramWetMix1   = "wetMix1";
    static constexpr auto paramWetMix2   = "wetMix2";
    static constexpr auto paramQuality   = "quality";
    static constexpr auto paramTomsound  = "tomsound";
    static constexpr auto paramFreeze    = "freeze";
    static constexpr auto paramAttenFb   = "attenFb";

    // Speed mode enum (GUI property, not a DSP parameter)
    enum SpeedMode { kSpeedMode_Fine = 0, kSpeedMode_Semitone = 1, kSpeedMode_Octave = 2, kNumSpeedModes = 3 };

    // ========================================================================
    TransverbAudioProcessor();
    ~TransverbAudioProcessor() override = default;

    void prepareToPlay(double sampleRate, int maxSamplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override;

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    const juce::String getName() const override;
    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram(int index) override;
    const juce::String getProgramName(int index) override;
    void changeProgramName(int index, const juce::String& newName) override;

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    void randomizeAllParameters();

    juce::AudioProcessorValueTreeState apvts;

    // Typed parameter pointers (owned by apvts, safe to expose for editor)
    juce::AudioParameterFloat*  pBufferSize  = nullptr;
    juce::AudioParameterFloat*  pSpeed1      = nullptr;
    juce::AudioParameterFloat*  pSpeed2      = nullptr;
    juce::AudioParameterFloat*  pFeedback1   = nullptr;
    juce::AudioParameterFloat*  pFeedback2   = nullptr;
    juce::AudioParameterFloat*  pDistance1   = nullptr;
    juce::AudioParameterFloat*  pDistance2   = nullptr;
    juce::AudioParameterFloat*  pDryMix      = nullptr;
    juce::AudioParameterFloat*  pWetMix1     = nullptr;
    juce::AudioParameterFloat*  pWetMix2     = nullptr;
    juce::AudioParameterChoice* pQuality     = nullptr;
    juce::AudioParameterBool*   pTomsound    = nullptr;
    juce::AudioParameterBool*   pFreeze      = nullptr;
    juce::AudioParameterBool*   pAttenFb     = nullptr;

    // Speed mode state (exposed for editor)
    std::array<int, 2> speedModes = { kSpeedMode_Fine, kSpeedMode_Fine };

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();
    void initPresets();

    // ---- D S P   S T A T E -------------------------------------------------
    struct HeadState
    {
        double readPos       = 0.0;
        int    smoothCount   = 0;
        float  smoothStep    = 0.0f;
        float  lastDelayVal  = 0.0f;
        float  currentSpeed  = 1.0f;
        bool   speedChanged  = false;

        std::vector<float> buf;                         // per-head circular buffer
        std::vector<float> firCoefficients;             // 23-tap Kaiser-windowed sinc
        bool   firValid = false;

        // IIR output history cache (4 samples for hermite post-filter interpolation)
        float iirHistory[4] = { 0.0f, 0.0f, 0.0f, 0.0f };
        int   iirHistoryPos = 0;
        int   lowpassPos    = 0;
        float iirZ1 = 0.0f, iirZ2 = 0.0f, iirY1 = 0.0f, iirY2 = 0.0f;
        float iirB0 = 0.0f, iirB1 = 0.0f, iirB2 = 0.0f, iirA1 = 0.0f, iirA2 = 0.0f;
        int   iirNumIterations = 1;
    };

    // ---- D S P   H E L P E R S ---------------------------------------------
    static inline float interpolateHermite(const float* buf, int bufSize,
                                           double readAddr, int writeAddr) noexcept;
    static inline float interpolateLinear(const float* buf, int bufSize,
                                          double readAddr) noexcept;

    // Set IIR lowpass coefficients (butterworth, bilinear transform)
    static void computeIIRLowpass(float cutoffNorm,
                                  float& b0, float& b1, float& b2,
                                  float& a1, float& a2) noexcept;
    // Run the IIR once (updates state)
    static inline float runIIR(float input,
                               float b0, float b1, float b2,
                               float a1, float a2,
                               float& z1, float& z2,
                               float& y1, float& y2) noexcept;
    // Hermite interpolation from the IIR output history
    static inline float interpolateHermitePostFilter(const float* history,
                                                      double readAddr,
                                                      int historyWritePos) noexcept;

    // Kaiser window helper
    static float besselI0(float x);
    static std::vector<float> generateKaiserWindow(int numTaps, float attenuationDB);

    // ---- D S P   M E M B E R S ----------------------------------------------
    static constexpr int kNumFIRTaps = 23;
    static constexpr int kNumPresets = 16;
    static constexpr int kAudioSmoothingDur = 42;
    static constexpr int kFIRSpeedThreshold = 5;
    static constexpr double kHighpassCutoff = 39.0;

    int    MAXBUF       = 0;
    int    bsize        = 0;               // effective buffer length (soft limit)
    int    writePos     = 0;
    double sampleRate   = 44100.0;

    std::array<HeadState, 2> heads;

    // Smoothing for parameter changes
    float smoothDryMix  = 0.5f;
    float smoothFeed1   = 0.5f;
    float smoothFeed2   = 0.5f;
    float smoothWet1    = 0.5f;
    float smoothWet2    = 0.5f;
    float smoothSpeed1  = 1.0f;
    float smoothSpeed2  = 1.0f;

    // Program / preset data
    std::array<juce::String, kNumPresets> programNames;
    int currentProgram = 0;

    // Stored preset values (one row per preset)
    struct PresetData {
        float bufferSize = 2700.0f;
        float speed1 = 0.0f, speed2 = 1.0f;
        float feedback1 = 0.0f, feedback2 = 0.0f;
        float distance1 = 0.90009f, distance2 = 0.1f;
        float dryMix = 1.0f, wetMix1 = 1.0f, wetMix2 = 0.0f;
        int   quality = 2; // Ultra Hi-Fi
        bool  tomsound = false, freeze = false, attenFb = false;
    };
    std::array<PresetData, kNumPresets> presets;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TransverbAudioProcessor)
};
