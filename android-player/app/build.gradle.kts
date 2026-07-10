plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

android {
	namespace = "com.karol.player"
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
		applicationId = "com.karol.player"
		minSdk = 26
		targetSdk = 35
		versionCode = 6
		versionName = "2.2.0"
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
	implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
	implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
	implementation("androidx.activity:activity-ktx:1.9.3")
	implementation("androidx.security:security-crypto:1.1.0-alpha06")
	implementation("io.ktor:ktor-server-core:2.3.12")
	implementation("io.ktor:ktor-server-cio:2.3.12")
	implementation("io.ktor:ktor-server-status-pages:2.3.12")
	implementation("com.google.zxing:core:3.5.3")
	implementation("com.squareup.okhttp3:okhttp:4.12.0")

	testImplementation("junit:junit:4.13.2")
	testImplementation("org.robolectric:robolectric:4.14.1")
	testImplementation("androidx.test:core:1.6.1")
}
