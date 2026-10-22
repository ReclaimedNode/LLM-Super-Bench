pm = resolve.GetProjectManager(); proj = pm.GetCurrentProject()
print("project:", proj.GetName() if proj else None)
if proj:
    n = proj.GetTimelineCount(); print("timelines:", n)
    for i in range(1, n+1):
        t = proj.GetTimelineByIndex(i)
        print(" -", t.GetName(), "frames", t.GetEndFrame()-t.GetStartFrame(), "fps", t.GetSetting("timelineFrameRate"), "V1 items", len(t.GetItemListInTrack("video",1) or []), "tracks", t.GetTrackCount("video"))
    mp = proj.GetMediaPool(); items = mp.GetRootFolder().GetClipList() or []
    print("media pool root:", [(c.GetName(), c.GetClipProperty("FPS"), c.GetClipProperty("Duration")) for c in items][:10])
