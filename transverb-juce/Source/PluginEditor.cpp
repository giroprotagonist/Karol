#include "PluginProcessor.h"
#include "PluginEditor.h"

TransverbAudioProcessorEditor::TransverbAudioProcessorEditor(TransverbAudioProcessor& proc)
    : AudioProcessorEditor(&proc)
    , processorRef(proc)
{
    setSize(780, 580);

    auto setupSlider = [this](juce::Slider& slider, juce::Label& label, juce::Label& valueLabel,
                               const juce::String& text)
    {
        slider.setSliderStyle(juce::Slider::LinearHorizontal);
        slider.setTextBoxStyle(juce::Slider::NoTextBox, false, 0, 0);
        slider.setColour(juce::Slider::thumbColourId, juce::Colour(0xff4a9eff));
        slider.setColour(juce::Slider::trackColourId, juce::Colour(0xff2a2a3a));
        slider.setColour(juce::Slider::backgroundColourId, juce::Colour(0xff1a1a2a));
        addAndMakeVisible(slider);
        label.setText(text, juce::dontSendNotification);
        label.setFont(juce::Font(12.0f, juce::Font::plain));
        label.setColour(juce::Label::textColourId, juce::Colours::lightgrey);
        addAndMakeVisible(label);
        valueLabel.setFont(juce::Font(11.0f, juce::Font::plain));
        valueLabel.setColour(juce::Label::textColourId, juce::Colour(0xff4a9eff));
        valueLabel.setJustificationType(juce::Justification::right);
        addAndMakeVisible(valueLabel);
    };

    auto setupSpeedBtn = [this](juce::TextButton& btn, const juce::String& text)
    {
        btn.setButtonText(text);
        btn.setColour(juce::TextButton::buttonColourId, juce::Colour(0xff2a2a3a));
        btn.setColour(juce::TextButton::buttonOnColourId, juce::Colour(0xff4a9eff));
        btn.setColour(juce::TextButton::textColourOffId, juce::Colours::lightgrey);
        btn.setColour(juce::TextButton::textColourOnId, juce::Colours::black);
        btn.setClickingTogglesState(true);
        btn.setRadioGroupId(0); // will override
        btn.setConnectedEdges(juce::Button::ConnectedOnLeft | juce::Button::ConnectedOnRight);
        addAndMakeVisible(btn);
    };

    // Title
    titleLabel.setText("TRAN  S  VERB", juce::dontSendNotification);
    titleLabel.setFont(juce::Font(28.0f, juce::Font::bold));
    titleLabel.setColour(juce::Label::textColourId, juce::Colour(0xff4a9eff));
    titleLabel.setJustificationType(juce::Justification::centred);
    addAndMakeVisible(titleLabel);

    // Sliders
    setupSlider(speed1Slider, speed1Label, speed1Value, "SPEED 1 (octaves)");
    setupSlider(speed2Slider, speed2Label, speed2Value, "SPEED 2 (octaves)");
    setupSlider(feedback1Slider, feedback1Label, feedback1Value, "FEEDBACK 1");
    setupSlider(feedback2Slider, feedback2Label, feedback2Value, "FEEDBACK 2");
    setupSlider(distance1Slider, distance1Label, distance1Value, "DISTANCE 1");
    setupSlider(distance2Slider, distance2Label, distance2Value, "DISTANCE 2");
    setupSlider(dryMixSlider, dryMixLabel, dryMixValue, "DRY MIX");
    setupSlider(wetMix1Slider, wetMix1Label, wetMix1Value, "WET MIX 1");
    setupSlider(wetMix2Slider, wetMix2Label, wetMix2Value, "WET MIX 2");
    setupSlider(bufferSizeSlider, bufferSizeLabel, bufferSizeValue, "BUFFER SIZE (ms)");

    // Speed mode buttons
    setupSpeedBtn(speed1FineBtn, "fine");
    setupSpeedBtn(speed1SemiBtn, "semi");
    setupSpeedBtn(speed1OctBtn, "8ve");
    speed1FineBtn.setRadioGroupId(1);
    speed1SemiBtn.setRadioGroupId(1);
    speed1OctBtn.setRadioGroupId(1);
    speed1FineBtn.onClick = [this]() {
        processorRef.speedModes[0] = TransverbAudioProcessor::kSpeedMode_Fine;
        updateSpeedModeButtons(0);
    };
    speed1SemiBtn.onClick = [this]() {
        processorRef.speedModes[0] = TransverbAudioProcessor::kSpeedMode_Semitone;
        updateSpeedModeButtons(0);
    };
    speed1OctBtn.onClick = [this]() {
        processorRef.speedModes[0] = TransverbAudioProcessor::kSpeedMode_Octave;
        updateSpeedModeButtons(0);
    };

    setupSpeedBtn(speed2FineBtn, "fine");
    setupSpeedBtn(speed2SemiBtn, "semi");
    setupSpeedBtn(speed2OctBtn, "8ve");
    speed2FineBtn.setRadioGroupId(2);
    speed2SemiBtn.setRadioGroupId(2);
    speed2OctBtn.setRadioGroupId(2);
    speed2FineBtn.onClick = [this]() {
        processorRef.speedModes[1] = TransverbAudioProcessor::kSpeedMode_Fine;
        updateSpeedModeButtons(1);
    };
    speed2SemiBtn.onClick = [this]() {
        processorRef.speedModes[1] = TransverbAudioProcessor::kSpeedMode_Semitone;
        updateSpeedModeButtons(1);
    };
    speed2OctBtn.onClick = [this]() {
        processorRef.speedModes[1] = TransverbAudioProcessor::kSpeedMode_Octave;
        updateSpeedModeButtons(1);
    };

    updateSpeedModeButtons(0);
    updateSpeedModeButtons(1);

    // Quality combo
    qualityLabel.setText("QUALITY", juce::dontSendNotification);
    qualityLabel.setFont(juce::Font(12.0f, juce::Font::plain));
    qualityLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey);
    addAndMakeVisible(qualityLabel);
    qualityCombo.addItemList({"Dirt-Fi", "Hi-Fi", "Ultra Hi-Fi"}, 1);
    qualityCombo.setSelectedId(3); // Ultra Hi-Fi default
    addAndMakeVisible(qualityCombo);

    // Toggles
    auto setupToggle = [this](juce::ToggleButton& btn, const juce::String& text, juce::Colour col)
    {
        btn.setButtonText(text);
        btn.setColour(juce::ToggleButton::textColourId, juce::Colours::lightgrey);
        btn.setColour(juce::ToggleButton::tickColourId, col);
        btn.setColour(juce::ToggleButton::tickDisabledColourId, col.withAlpha(0.3f));
        addAndMakeVisible(btn);
    };
    setupToggle(tomsoundButton, "TOMSOUND", juce::Colour(0xff4a9eff));
    setupToggle(freezeButton, "FREEZE", juce::Colour(0xffe04040));
    setupToggle(attenFbButton, "-fdb", juce::Colour(0xff40c040));

    // Randomize button
    randomizeBtn.setButtonText("RANDOMIZE");
    randomizeBtn.setColour(juce::TextButton::buttonColourId, juce::Colour(0xff3a1a5a));
    randomizeBtn.setColour(juce::TextButton::textColourOffId, juce::Colours::lightgrey);
    randomizeBtn.onClick = [this]() { processorRef.randomizeAllParameters(); };
    addAndMakeVisible(randomizeBtn);

    // Preset selector
    presetLabel.setText("PRESET", juce::dontSendNotification);
    presetLabel.setFont(juce::Font(12.0f, juce::Font::plain));
    presetLabel.setColour(juce::Label::textColourId, juce::Colours::lightgrey);
    addAndMakeVisible(presetLabel);
    buildPresetList();
    presetBox.addListener(this);
    addAndMakeVisible(presetBox);

    // Attachments
    auto& apvts = processorRef.apvts;
    bufferSizeAttach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramBufferSize, bufferSizeSlider);
    speed1Attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramSpeed1, speed1Slider);
    speed2Attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramSpeed2, speed2Slider);
    feedback1Attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramFeedback1, feedback1Slider);
    feedback2Attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramFeedback2, feedback2Slider);
    distance1Attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramDistance1, distance1Slider);
    distance2Attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramDistance2, distance2Slider);
    dryMixAttach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramDryMix, dryMixSlider);
    wetMix1Attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramWetMix1, wetMix1Slider);
    wetMix2Attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(apvts,
        TransverbAudioProcessor::paramWetMix2, wetMix2Slider);
    qualityAttach = std::make_unique<juce::AudioProcessorValueTreeState::ComboBoxAttachment>(apvts,
        TransverbAudioProcessor::paramQuality, qualityCombo);
    tomsoundAttach = std::make_unique<juce::AudioProcessorValueTreeState::ButtonAttachment>(apvts,
        TransverbAudioProcessor::paramTomsound, tomsoundButton);
    freezeAttach = std::make_unique<juce::AudioProcessorValueTreeState::ButtonAttachment>(apvts,
        TransverbAudioProcessor::paramFreeze, freezeButton);
    attenFbAttach = std::make_unique<juce::AudioProcessorValueTreeState::ButtonAttachment>(apvts,
        TransverbAudioProcessor::paramAttenFb, attenFbButton);

    startTimerHz(20);
}

TransverbAudioProcessorEditor::~TransverbAudioProcessorEditor() = default;

void TransverbAudioProcessorEditor::buildPresetList() {
    presetBox.clear();
    for (int i = 0; i < processorRef.getNumPrograms(); ++i)
        presetBox.addItem(processorRef.getProgramName(i), i + 1);
}

void TransverbAudioProcessorEditor::comboBoxChanged(juce::ComboBox* box) {
    if (box == &presetBox) {
        int idx = presetBox.getSelectedId() - 1;
        if (idx >= 0)
            processorRef.setCurrentProgram(idx);
    }
}

void TransverbAudioProcessorEditor::updateSpeedModeButtons(int head)
{
    int mode = processorRef.speedModes[head];
    auto& fine = (head == 0) ? speed1FineBtn : speed2FineBtn;
    auto& semi = (head == 0) ? speed1SemiBtn : speed2SemiBtn;
    auto& oct  = (head == 0) ? speed1OctBtn  : speed2OctBtn;

    fine.setToggleState(mode == TransverbAudioProcessor::kSpeedMode_Fine, juce::dontSendNotification);
    semi.setToggleState(mode == TransverbAudioProcessor::kSpeedMode_Semitone, juce::dontSendNotification);
    oct.setToggleState(mode == TransverbAudioProcessor::kSpeedMode_Octave, juce::dontSendNotification);
}

void TransverbAudioProcessorEditor::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colour(0xff12121a));
    g.setColour(juce::Colour(0xff1a1a26));
    for (int y = 0; y < getHeight(); y += 40)
        g.drawHorizontalLine(y, 0.0f, static_cast<float>(getWidth()));
    for (int x = 0; x < getWidth(); x += 40)
        g.drawVerticalLine(x, 0.0f, static_cast<float>(getHeight()));

    g.setColour(juce::Colour(0xff1e1e2e));
    g.fillRect(0, getHeight() - 34, getWidth(), 34);
    g.setColour(juce::Colours::grey);
    g.setFont(11.0f);
    g.drawText("Transverb  ·  JUCE  ·  Karol  ·  GPL v2+",
               getLocalBounds().removeFromBottom(30).toFloat(), juce::Justification::centred);
}

void TransverbAudioProcessorEditor::resized()
{
    auto area = getLocalBounds().reduced(16, 12);
    area.removeFromTop(4);

    titleLabel.setBounds(area.removeFromTop(28));
    area.removeFromTop(6);

    auto rowHeight = [&area]() { return area.removeFromTop(44); };
    auto colWidth = (area.getWidth() - 16) / 2;

    // Helper: layout a slider row with left and right columns
    auto layoutRow = [&](juce::Slider& lSlider, juce::Label& lLabel, juce::Label& lVal,
                         juce::Slider& rSlider, juce::Label& rLabel, juce::Label& rVal)
    {
        auto row = rowHeight();
        auto left  = row.removeFromLeft(colWidth);
        auto right = row.removeFromLeft(colWidth);
        row.removeFromLeft(16); // gap

        lLabel.setBounds(left.removeFromTop(14));
        lVal.setBounds(left.removeFromRight(60).removeFromTop(14));
        lSlider.setBounds(left);

        rLabel.setBounds(right.removeFromTop(14));
        rVal.setBounds(right.removeFromRight(60).removeFromTop(14));
        rSlider.setBounds(right);
    };

    layoutRow(speed1Slider, speed1Label, speed1Value,
              speed2Slider, speed2Label, speed2Value);

    // Speed mode buttons under speed sliders – little adjustment for this row
    // (buttons placed below the sliders in a thin row)
    {
        auto btnRow = rowHeight().removeFromTop(18);
        auto leftBtnArea  = btnRow.removeFromLeft(colWidth);
        auto rightBtnArea = btnRow.removeFromLeft(colWidth);
        int bw = 36;
        speed1FineBtn.setBounds(leftBtnArea.removeFromLeft(bw));
        speed1SemiBtn.setBounds(leftBtnArea.removeFromLeft(bw));
        speed1OctBtn.setBounds(leftBtnArea.removeFromLeft(bw));
        speed2FineBtn.setBounds(rightBtnArea.removeFromLeft(bw));
        speed2SemiBtn.setBounds(rightBtnArea.removeFromLeft(bw));
        speed2OctBtn.setBounds(rightBtnArea.removeFromLeft(bw));
    }

    layoutRow(feedback1Slider, feedback1Label, feedback1Value,
              feedback2Slider, feedback2Label, feedback2Value);
    layoutRow(distance1Slider, distance1Label, distance1Value,
              distance2Slider, distance2Label, distance2Value);
    layoutRow(dryMixSlider, dryMixLabel, dryMixValue,
              wetMix1Slider, wetMix1Label, wetMix1Value);
    layoutRow(wetMix2Slider, wetMix2Label, wetMix2Value,
              bufferSizeSlider, bufferSizeLabel, bufferSizeValue);

    area.removeFromTop(4);

    // Bottom row: quality, toggles, preset, randomize
    auto bottomRow = area.removeFromTop(32);
    presetLabel.setBounds(bottomRow.removeFromLeft(44));
    presetBox.setBounds(bottomRow.removeFromLeft(110));
    bottomRow.removeFromLeft(12);
    randomizeBtn.setBounds(bottomRow.removeFromLeft(90));
    bottomRow.removeFromLeft(12);
    qualityLabel.setBounds(bottomRow.removeFromLeft(44));
    qualityCombo.setBounds(bottomRow.removeFromLeft(100));
    bottomRow.removeFromLeft(12);
    tomsoundButton.setBounds(bottomRow.removeFromLeft(90));
    bottomRow.removeFromLeft(8);
    freezeButton.setBounds(bottomRow.removeFromLeft(70));
    bottomRow.removeFromLeft(8);
    attenFbButton.setBounds(bottomRow.removeFromLeft(50));
}

void TransverbAudioProcessorEditor::timerCallback()
{
    auto fmtOctaves = [](float oct) -> juce::String {
        int o = static_cast<int>(oct);
        int leftover = static_cast<int>((oct - static_cast<float>(o)) * 12.0f + 0.5f);
        if (leftover < 0) leftover += 12;
        return juce::String(o) + "o " + juce::String(leftover) + "s";
    };

    auto fmtPercent = [](float v) -> juce::String {
        return juce::String(static_cast<int>(v + 0.5f)) + "%";
    };

    speed1Value.setText(fmtOctaves(processorRef.pSpeed1->get()), juce::dontSendNotification);
    speed2Value.setText(fmtOctaves(processorRef.pSpeed2->get()), juce::dontSendNotification);
    feedback1Value.setText(fmtPercent(processorRef.pFeedback1->get()), juce::dontSendNotification);
    feedback2Value.setText(fmtPercent(processorRef.pFeedback2->get()), juce::dontSendNotification);
    distance1Value.setText(juce::String(processorRef.pDistance1->get(), 3), juce::dontSendNotification);
    distance2Value.setText(juce::String(processorRef.pDistance2->get(), 3), juce::dontSendNotification);
    dryMixValue.setText(fmtPercent(processorRef.pDryMix->get() * 100.0f), juce::dontSendNotification);
    wetMix1Value.setText(fmtPercent(processorRef.pWetMix1->get() * 100.0f), juce::dontSendNotification);
    wetMix2Value.setText(fmtPercent(processorRef.pWetMix2->get() * 100.0f), juce::dontSendNotification);
    bufferSizeValue.setText(juce::String(static_cast<int>(processorRef.pBufferSize->get())) + " ms", juce::dontSendNotification);
}
