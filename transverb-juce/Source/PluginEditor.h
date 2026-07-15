#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

class TransverbAudioProcessorEditor : public juce::AudioProcessorEditor,
                                       public juce::Timer,
                                       public juce::ComboBox::Listener
{
public:
    explicit TransverbAudioProcessorEditor(TransverbAudioProcessor& proc);
    ~TransverbAudioProcessorEditor() override;

    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;
    void comboBoxChanged(juce::ComboBox* box) override;

private:
    TransverbAudioProcessor& processorRef;

    juce::Label titleLabel;

    // Sliders
    juce::Slider bufferSizeSlider;
    juce::Label  bufferSizeLabel, bufferSizeValue;

    juce::Slider speed1Slider;
    juce::Label  speed1Label, speed1Value;
    juce::TextButton speed1FineBtn, speed1SemiBtn, speed1OctBtn;

    juce::Slider speed2Slider;
    juce::Label  speed2Label, speed2Value;
    juce::TextButton speed2FineBtn, speed2SemiBtn, speed2OctBtn;

    juce::Slider feedback1Slider;
    juce::Label  feedback1Label, feedback1Value;

    juce::Slider feedback2Slider;
    juce::Label  feedback2Label, feedback2Value;

    juce::Slider distance1Slider;
    juce::Label  distance1Label, distance1Value;

    juce::Slider distance2Slider;
    juce::Label  distance2Label, distance2Value;

    juce::Slider dryMixSlider;
    juce::Label  dryMixLabel, dryMixValue;

    juce::Slider wetMix1Slider;
    juce::Label  wetMix1Label, wetMix1Value;

    juce::Slider wetMix2Slider;
    juce::Label  wetMix2Label, wetMix2Value;

    juce::ComboBox qualityCombo;
    juce::Label    qualityLabel;

    juce::ToggleButton tomsoundButton;
    juce::ToggleButton freezeButton;
    juce::ToggleButton attenFbButton;

    juce::ComboBox presetBox;
    juce::Label    presetLabel;

    juce::TextButton randomizeBtn;

    // Attachments
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> bufferSizeAttach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> speed1Attach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> speed2Attach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> feedback1Attach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> feedback2Attach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> distance1Attach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> distance2Attach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> dryMixAttach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> wetMix1Attach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> wetMix2Attach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::ComboBoxAttachment> qualityAttach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::ButtonAttachment> tomsoundAttach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::ButtonAttachment> freezeAttach;
    std::unique_ptr<juce::AudioProcessorValueTreeState::ButtonAttachment> attenFbAttach;

    void updateSpeedModeButtons(int head);
    void buildPresetList();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TransverbAudioProcessorEditor)
};
