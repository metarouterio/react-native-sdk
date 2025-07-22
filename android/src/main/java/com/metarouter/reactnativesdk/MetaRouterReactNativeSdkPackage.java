package com.metarouter.reactnativesdk;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

// Import the bundled packages
import com.reactnativecommunity.asyncstorage.AsyncStoragePackage;
import com.segmentanalyticsreactnative.AnalyticsReactNativePackage;
import com.sovranreactnative.Sovran;
import org.linusu.RNGetRandomValuesPackage;

public class MetaRouterReactNativeSDKPackage implements ReactPackage {

    // Create instances of bundled packages
    private final AsyncStoragePackage asyncStoragePackage = new AsyncStoragePackage();
    private final AnalyticsReactNativePackage analyticsPackage = new AnalyticsReactNativePackage();
    private final Sovran sovranPackage = new Sovran();
    private final RNGetRandomValuesPackage randomValuesPackage = new RNGetRandomValuesPackage();

    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
        List<NativeModule> modules = new ArrayList<>();
        
        // Add modules from all bundled packages
        modules.addAll(asyncStoragePackage.createNativeModules(reactContext));
        modules.addAll(analyticsPackage.createNativeModules(reactContext));
        modules.addAll(sovranPackage.createNativeModules(reactContext));
        modules.addAll(randomValuesPackage.createNativeModules(reactContext));
        
        // Add your own SDK modules here if you have any
        // modules.add(new MetaRouterModule(reactContext));
        
        return modules;
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        List<ViewManager> viewManagers = new ArrayList<>();
        
        // Add view managers from all bundled packages
        viewManagers.addAll(asyncStoragePackage.createViewManagers(reactContext));
        viewManagers.addAll(analyticsPackage.createViewManagers(reactContext));
        viewManagers.addAll(sovranPackage.createViewManagers(reactContext));
        viewManagers.addAll(randomValuesPackage.createViewManagers(reactContext));
        
        return viewManagers;
    }
}