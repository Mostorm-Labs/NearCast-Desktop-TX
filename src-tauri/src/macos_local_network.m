#import <Foundation/Foundation.h>
#import <Network/Network.h>
#include <dns_sd.h>

uint8_t nearcast_macos_has_content_sharing_picker(void) {
    if (@available(macOS 14.0, *)) return NSClassFromString(@"SCContentSharingPicker") != Nil;
    return 0;
}

// 0 = unknown, 1 = Bonjour browser ready, 2 = explicit privacy policy denial.
// There is no general Local Network authorization query. A successful raw UDP
// send, an empty result set, and ordinary network errors cannot prove consent.
uint8_t nearcast_macos_local_network_status(void) {
    @autoreleasepool {
        nw_browse_descriptor_t descriptor = nw_browse_descriptor_create_bonjour_service("_nearcast._tcp", "local.");
        nw_browser_t browser = nw_browser_create(descriptor, nw_parameters_create());
        if (!browser) return 0;
        dispatch_queue_t queue = dispatch_queue_create("com.mostorm.nearhub.local-network-check", DISPATCH_QUEUE_SERIAL);
        dispatch_semaphore_t settled = dispatch_semaphore_create(0);
        __block uint8_t observed = 0;
        nw_browser_set_queue(browser, queue);
        nw_browser_set_state_changed_handler(browser, ^(nw_browser_state_t state, nw_error_t error) {
            if (state == nw_browser_state_ready) observed = 1;
            else if (state == nw_browser_state_waiting || state == nw_browser_state_failed) {
                observed = error && nw_error_get_error_domain(error) == nw_error_domain_dns
                    && nw_error_get_error_code(error) == kDNSServiceErr_PolicyDenied ? 2 : 0;
            }
        });
        nw_browser_start(browser);
        // Ready may be followed by a policy denial. Observe the latest state,
        // with a bounded wait on a Rust blocking worker, never the UI thread.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 600 * NSEC_PER_MSEC), queue, ^{
            dispatch_semaphore_signal(settled);
        });
        long timedOut = dispatch_semaphore_wait(settled, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC));
        __block uint8_t result = 0;
        dispatch_sync(queue, ^{
            if (!timedOut) result = observed;
            nw_browser_cancel(browser);
        });
        // Cancellation owns the remaining callback lifetime; its captured
        // state lives on the heap and never references a Rust stack pointer.
        return result;
    }
}
