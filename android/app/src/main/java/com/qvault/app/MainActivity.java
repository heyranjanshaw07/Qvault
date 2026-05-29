package com.qvault.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Prevent screenshots and screen recording for high-security zero-knowledge document protection
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }
}
