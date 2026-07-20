cmake_minimum_required(VERSION 3.22)

project(Transverb VERSION 1.0.0)

# Fetch JUCE
include(FetchContent)
FetchContent_Declare(
    juce
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.6
)
FetchContent_MakeAvailable(juce)

# Plugin target
juce_add_plugin(Transverb
    COMPANY_NAME "Karol"
    PLUGIN_MANUFACTURER_CODE DfxT
    PLUGIN_CODE Tvrb
    FORMATS AU VST3
    PRODUCT_NAME "Transverb"
    VERSION ${PROJECT_VERSION}
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    COPY_PLUGIN_AFTER_BUILD TRUE
)

target_sources(Transverb PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/Source/PluginProcessor.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/Source/PluginProcessor.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/Source/PluginEditor.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/Source/PluginEditor.h"
)

target_compile_features(Transverb PUBLIC cxx_std_20)

# macOS-specific settings
if(APPLE)
    set_target_properties(Transverb PROPERTIES
        XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY ""
        XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED NO
        XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED NO
    )
endif()
