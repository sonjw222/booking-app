package com.mwhabit.app;

import android.graphics.Color;
import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Sets the surface behind Android's transparent edge-to-edge status bar. */
@CapacitorPlugin(name = "AndroidStatusBarBackground")
public class AndroidStatusBarBackgroundPlugin extends Plugin {
    @PluginMethod
    public void setDark(PluginCall call) {
        boolean dark = call.getBoolean("dark", false);
        getActivity().runOnUiThread(() -> {
            View contentRoot = getActivity().findViewById(android.R.id.content);
            if (contentRoot != null) {
                contentRoot.setBackgroundColor(Color.parseColor(dark ? "#17181C" : "#FBFBFA"));
            }
            call.resolve();
        });
    }
}
