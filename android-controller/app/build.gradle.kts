plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

android {
	namespace = "com.karol.controller"
	compileSdk = 35

	signingConfigs {
		create("release") {
			storeFile = file("karol-release.keystore")
			storePassword = "karol123"
			keyAlias = "karol"
			keyPassword = "karol123"
		}
	}

	defaultConfig {
		applicationId = "com.karol.controller"
		minSdk = 26
		targetSdk = 35
		versionCode = 5
		versionName = "2.1.0"
		testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
	}

	testOptions {
		unitTests.isIncludeAndroidResources = true
	}

	buildTypes {
		release {
			isMinifyEnabled = false
			proguardFiles(
				getDefaultProguardFile("proguard-android-optimize.txt"),
				"proguard-rules.pro",
			)
			signingConfig = signingConfigs.getByName("release")
		}
	}

	buildFeatures {
		buildConfig = true
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	kotlinOptions {
		jvmTarget = "17"
	}
}

dependencies {
	implementation("androidx.core:core-ktx:1.15.0")
	implementation("androidx.appcompat:appcompat:1.7.0")
	implementation("com.google.android.material:material:1.12.0")
	implementation("androidx.browser:browser:1.8.0")
	implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
	implementation("androidx.camera:camera-camera2:1.4.1")
	implementation("androidx.camera:camera-lifecycle:1.4.1")
	implementation("androidx.camera:camera-view:1.4.1")
	implementation("com.google.mlkit:barcode-scanning:17.3.0")
	implementation("androidx.media:media:1.7.0")

	testImplementation("junit:junit:4.13.2")
	testImplementation("org.robolectric:robolectric:4.14.1")
}
