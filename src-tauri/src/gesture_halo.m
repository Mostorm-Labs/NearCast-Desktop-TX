#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

// Bounded, click-through feedback only. No input synthesis or focus changes.
// The feed comes from the current leased owner, never from network/UI coordinates.
@interface NearcastHaloView : NSView
@property NSInteger stage;
@property double progress;
@end
@implementation NearcastHaloView
- (BOOL)isOpaque { return NO; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSRect ring=NSInsetRect(self.bounds,10,10);
    NSColor *cyan=[NSColor colorWithRed:.25 green:.85 blue:1 alpha:.9];
    NSColor *green=[NSColor colorWithRed:.3 green:1 blue:.55 alpha:.95];
    NSColor *purple=[NSColor colorWithRed:.8 green:.5 blue:1 alpha:.95];
    NSColor *color=self.stage==1?cyan:
        self.stage==2||self.stage==7?green:
        self.stage==3?[NSColor colorWithRed:.3 green:.65 blue:1 alpha:.95]:
        self.stage==4||self.stage==8||self.stage==10?purple:
        self.stage==5?[NSColor colorWithRed:1 green:.7 blue:.2 alpha:.95]:[NSColor colorWithWhite:.7 alpha:.7];
    if(self.stage==9||self.stage==10){
        // A brief expanding, rotating release pulse. It is feedback only; no
        // timer can produce an input action. JS bounds the lifetime to 280 ms.
        double p=self.progress,angle=90-360*p;
        NSColor *pulse=self.stage==10?purple:cyan;
        [[pulse colorWithAlphaComponent:(1-p)*.9] setStroke];
        NSBezierPath *arc=[NSBezierPath bezierPath];arc.lineWidth=4*(1-p)+1;
        [arc appendBezierPathWithArcWithCenter:NSMakePoint(40,40) radius:25+11*p startAngle:angle endAngle:angle-290 clockwise:YES];[arc stroke];
        [[pulse colorWithAlphaComponent:(1-p)*.18] setFill];[[NSBezierPath bezierPathWithOvalInRect:NSInsetRect(ring,8,8)] fill];
        return;
    }
    [[color colorWithAlphaComponent:.12] setFill];[[NSBezierPath bezierPathWithOvalInRect:ring] fill];
    [[NSColor colorWithWhite:1 alpha:.35] setStroke];NSBezierPath *base=[NSBezierPath bezierPathWithOvalInRect:ring];base.lineWidth=2;[base stroke];
    [color setStroke];
    if(self.stage==7){
        // Green outer ring preserves drag readiness while the purple inner
        // arc counts the additional wait until release becomes a right click.
        NSBezierPath *outer=[NSBezierPath bezierPathWithOvalInRect:ring];outer.lineWidth=3;[outer stroke];
        [purple setStroke];NSBezierPath *arc=[NSBezierPath bezierPath];arc.lineWidth=4;
        [arc appendBezierPathWithArcWithCenter:NSMakePoint(40,40) radius:22 startAngle:90 endAngle:90-360*self.progress clockwise:YES];[arc stroke];
    }else if(self.stage==8){
        NSBezierPath *outer=[NSBezierPath bezierPathWithOvalInRect:ring];outer.lineWidth=3;[outer stroke];
        double angle=90-fmod(CACurrentMediaTime()*180,360);
        [[NSColor colorWithWhite:1 alpha:.9] setStroke];NSBezierPath *arc=[NSBezierPath bezierPath];arc.lineWidth=4;
        [arc appendBezierPathWithArcWithCenter:NSMakePoint(40,40) radius:22 startAngle:angle endAngle:angle-90 clockwise:YES];[arc stroke];
    }else if(self.stage==1){
        NSBezierPath *arc=[NSBezierPath bezierPath];arc.lineWidth=4;
        [arc appendBezierPathWithArcWithCenter:NSMakePoint(40,40) radius:30 startAngle:90 endAngle:90-360*self.progress clockwise:YES];[arc stroke];
    }else{
        NSBezierPath *outer=[NSBezierPath bezierPathWithOvalInRect:ring];outer.lineWidth=4;[outer stroke];
        if(self.stage==2||self.stage==4||self.stage==5){
            NSBezierPath *inner=[NSBezierPath bezierPathWithOvalInRect:NSInsetRect(ring,7,7)];inner.lineWidth=2;[inner stroke];
        }
    }
    if(self.stage==4||self.stage==5){
        [color setFill];for(int direction=-1;direction<=1;direction+=2){[[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(37+direction*10,37,6,6)] fill];}
    }
}
@end

@interface NearcastHaloPanel : NSPanel
@end
@implementation NearcastHaloPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

static NearcastHaloPanel *halo;
static NearcastHaloView *view;
static NSTimer *expiry;
static CFTimeInterval deadline;

void nearcast_halo_clear(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [halo orderOut:nil];[expiry invalidate];expiry=nil;
    });
}

// stage 1 holding, 2 armed, 3 dragging, 4 two fingers, 5 pinch, 6 scroll,
// 7 right waiting, 8 right ready, 9 released, 10 right released.
void nearcast_halo_show(double x,double y,int stage,double progress) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if(!isfinite(x)||!isfinite(y)||!isfinite(progress)||stage<1||stage>10)return;
        if(!halo){
            halo=[[NearcastHaloPanel alloc] initWithContentRect:NSMakeRect(0,0,80,80)
                styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
            halo.opaque=NO;halo.backgroundColor=NSColor.clearColor;halo.hasShadow=NO;
            halo.ignoresMouseEvents=YES;halo.hidesOnDeactivate=NO;halo.level=NSStatusWindowLevel;
            halo.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary|NSWindowCollectionBehaviorIgnoresCycle;
            view=[[NearcastHaloView alloc] initWithFrame:NSMakeRect(0,0,80,80)];halo.contentView=view;
        }
        // CGEvent uses upper-left desktop points; AppKit uses lower-left.
        NSScreen *primary=NSScreen.screens.firstObject;
        CGFloat top=primary?NSMaxY(primary.frame):0;
        [halo setFrameOrigin:NSMakePoint(x-40,top-y-40)];
        view.stage=stage;view.progress=fmin(1,fmax(0,progress));[view setNeedsDisplay:YES];
        [halo orderFrontRegardless];deadline=CACurrentMediaTime()+.5;
        if(!expiry){
            expiry=[NSTimer timerWithTimeInterval:1.0/30.0 repeats:YES block:^(NSTimer *timer){
                if(view.stage==8)[view setNeedsDisplay:YES];
                if(CACurrentMediaTime()>deadline){[halo orderOut:nil];[timer invalidate];expiry=nil;}
            }];
            [[NSRunLoop mainRunLoop] addTimer:expiry forMode:NSRunLoopCommonModes];
        }
    });
}
